import Foundation
import Vision
import AppKit

// Local-only OCR via Apple Vision. No network access.
guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: ocr_local.swift <image>\n".data(using: .utf8)!)
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot load image\n".data(using: .utf8)!)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]
if #available(macOS 13.0, *) {
    request.revision = VNRecognizeTextRequestRevision3
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("OCR failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

guard let observations = request.results else { exit(0) }

struct Line {
    let text: String
    let x: CGFloat
    let y: CGFloat
    let confidence: Float
}

var lines: [Line] = []
for obs in observations {
    guard let candidate = obs.topCandidates(1).first else { continue }
    let box = obs.boundingBox
    lines.append(Line(text: candidate.string,
                      x: box.minX,
                      y: box.midY,
                      confidence: candidate.confidence))
}

// Vision's origin is bottom-left: sort top-to-bottom, then left-to-right.
lines.sort { a, b in
    if abs(a.y - b.y) > 0.012 { return a.y > b.y }
    return a.x < b.x
}

for line in lines {
    print(String(format: "%.4f\t%.4f\t%.3f\t%@", line.x, line.y, line.confidence, line.text))
}
