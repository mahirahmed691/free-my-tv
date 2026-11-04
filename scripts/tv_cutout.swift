// A pet cut out of its photo: tv_cutout <upright.jpg> <out.png>
// Apple's Vision separates what's in front (macOS 14+); several subjects (a hand beside the cat): the one the animal
// is in. A dark photo is brought up, or the animal disappears on a dark home screen. A PNG with a clear background,
// trimmed to the animal, at most 640 px, no metadata. Compiled by scripts/tv_photos.py into out/bin, and given tv_photo's
// upright output.
import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ text: String) -> Never {
    FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("can't read the image") }

let handler = VNImageRequestHandler(cgImage: image, options: [:])
let masks = VNGenerateForegroundInstanceMaskRequest()
do { try handler.perform([masks]) } catch { fail("Vision: \(error)") }
guard let result = masks.results?.first, !result.allInstances.isEmpty else { fail("nothing in front found") }

// The instance under the animal's nose or eyes, when Vision finds them; else every instance.
var wanted = result.allInstances
let pose = VNDetectAnimalBodyPoseRequest()
try? handler.perform([pose])
if let found = pose.results?.first, let points = try? found.recognizedPoints(.all) {
    let names: [VNAnimalBodyPoseObservation.JointName] = [.nose, .leftEye, .rightEye]
    if let spot = names.compactMap({ points[$0] }).first(where: { $0.confidence > 0.3 }) {
        let labels = result.instanceMask
        CVPixelBufferLockBaseAddress(labels, .readOnly)
        let x = Int(spot.location.x * CGFloat(CVPixelBufferGetWidth(labels)))
        let y = Int((1 - spot.location.y) * CGFloat(CVPixelBufferGetHeight(labels)))
        let row = CVPixelBufferGetBaseAddress(labels)!.advanced(by: y * CVPixelBufferGetBytesPerRow(labels))
        let label = Int(row.assumingMemoryBound(to: UInt8.self)[x])
        CVPixelBufferUnlockBaseAddress(labels, .readOnly)
        if label != 0 { wanted = IndexSet(integer: label) }
    }
}
guard let cut = try? result.generateMaskedImage(ofInstances: wanted, from: handler, croppedToInstancesExtent: true) else { fail("no cut-out") }

let ci = CIImage(cvPixelBuffer: cut)
let scale = min(1, 640 / max(ci.extent.width, ci.extent.height))
let small = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let context = CIContext()

/// The stops that bring the animal's average brightness up to 0.42: never down, and one stop at most.
func lift(_ picture: CIImage) -> Float {
    guard let average = CIFilter(name: "CIAreaAverage", parameters: [kCIInputImageKey: picture, kCIInputExtentKey: CIVector(cgRect: picture.extent)])?.outputImage else { return 0 }
    var p = [Float](repeating: 0, count: 4)
    context.render(average, toBitmap: &p, rowBytes: 16, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: nil)
    let luma = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / max(p[3], 0.01)
    return min(1, max(0, log2(0.42 / max(luma, 0.01))))
}

let bright = small.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: lift(small)])
guard let out = context.createCGImage(bright, from: small.extent),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("can't write") }
CGImageDestinationAddImage(dest, out, nil)
if !CGImageDestinationFinalize(dest) { fail("can't write") }
