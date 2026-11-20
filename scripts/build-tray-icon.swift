import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fatalError("Usage: build-tray-icon.swift <source.png> <output.png>")
}
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let image = NSImage(contentsOf: source),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fatalError("Could not load tray artwork: \(source.path)")
}

let logoHeight = 28
let height = 36
let width = Int(ceil(Double(logoHeight) * Double(cgImage.width) / Double(cgImage.height)))
guard let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8,
    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Could not create tray image context")
}
context.interpolationQuality = .high
context.draw(cgImage, in: CGRect(x: 0, y: 4, width: width, height: logoHeight))
guard let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else {
    fatalError("Could not access tray image pixels")
}
for pixel in 0..<(width * height) {
    bytes[pixel * 4] = 0
    bytes[pixel * 4 + 1] = 0
    bytes[pixel * 4 + 2] = 0
}
guard let result = context.makeImage(),
      let png = NSBitmapImageRep(cgImage: result).representation(using: .png, properties: [:]) else {
    fatalError("Could not encode tray image")
}
try png.write(to: output, options: .atomic)
