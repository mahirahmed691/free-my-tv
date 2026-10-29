// A round photo's square for a pet: tv_pet <upright.jpg> <out.jpg>
// Apple's Vision finds the animal's face (its eyes, nose and ears, from the body pose) and the square is cut around
// it; without a face, around the top of the animal it found; without either, from the middle. 320x320 JPEG, no
// metadata. Compiled by scripts/tv_photos.py into out/bin, and given tv_photo's upright output.
import CoreGraphics
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write("can't read the image\n".data(using: .utf8)!)
    exit(2)
}
let w = CGFloat(image.width), h = CGFloat(image.height)

/// The face: its centre and a side for the square, in pixels from the top left. Sized from the eyes (a cat's face
/// is about 2.5 eyes' distances wide) or the ears, with room around; centred on the eyes and nose, a little higher.
func face() -> (CGPoint, CGFloat)? {
    let request = VNDetectAnimalBodyPoseRequest()
    try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    guard let pose = request.results?.first, let points = try? pose.recognizedPoints(.all) else { return nil }
    func at(_ name: VNAnimalBodyPoseObservation.JointName) -> CGPoint? {
        guard let p = points[name], p.confidence > 0.3 else { return nil }
        return CGPoint(x: CGFloat(p.location.x) * w, y: (1 - CGFloat(p.location.y)) * h)
    }
    let names: [VNAnimalBodyPoseObservation.JointName] = [.leftEye, .rightEye, .nose]
    let features = names.compactMap(at)
    guard features.count >= 2 else { return nil }
    var side: CGFloat = 0
    if let l = at(.leftEye), let r = at(.rightEye) { side = hypot(l.x - r.x, l.y - r.y) * 3.25 }
    if let l = at(.leftEarBottom) ?? at(.leftEarMiddle),
       let r = at(.rightEarBottom) ?? at(.rightEarMiddle) { side = max(side, hypot(l.x - r.x, l.y - r.y) * 1.3) }
    if side == 0 { side = min(w, h) * 0.5 }
    let centre = CGPoint(x: features.map { $0.x }.reduce(0, +) / CGFloat(features.count),
                         y: features.map { $0.y }.reduce(0, +) / CGFloat(features.count) - side * 0.08)
    return (centre, side)
}

/// The top of the animal Vision recognised (a cat's head is usually there).
func animal() -> (CGPoint, CGFloat)? {
    let request = VNRecognizeAnimalsRequest()
    try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    guard let box = request.results?.first?.boundingBox else { return nil }
    let side = min(box.width * w, box.height * h)
    let top = (1 - box.maxY) * h
    return (CGPoint(x: box.midX * w, y: top + side / 2), side)
}

var (centre, side) = face() ?? animal() ?? (CGPoint(x: w / 2, y: h / 2), min(w, h))
side = min(side, w, h)
let x = max(0, min(w - side, centre.x - side / 2)), y = max(0, min(h - side, centre.y - side / 2))
guard let crop = image.cropping(to: CGRect(x: x, y: y, width: side, height: side).integral),
      let context = CGContext(data: nil, width: 320, height: 320, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(3) }
context.interpolationQuality = .high
context.draw(crop, in: CGRect(x: 0, y: 0, width: 320, height: 320))
guard let square = context.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, "public.jpeg" as CFString, 1, nil) else { exit(3) }
CGImageDestinationAddImage(dest, square, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
exit(CGImageDestinationFinalize(dest) ? 0 : 4)
