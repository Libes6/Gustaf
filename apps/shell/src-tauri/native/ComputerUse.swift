// The OS calls behind computer use. Every decision (who may act, where a point lands, what is
// still held, when to stop) is made in computer_use.rs; this process only performs one call per
// request and never logs what it captures or types.
import AppKit
import ApplicationServices
import Carbon
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Failure: Error { let message: String }

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

let source = CGEventSource(stateID: .privateState)
var heldButtons: Set<String> = []
var heldKeys: Set<CGKeyCode> = []

func displays() -> [[String: Any]] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    let names: [CGDirectDisplayID: String] = DispatchQueue.main.sync {
        var names: [CGDirectDisplayID: String] = [:]
        for screen in NSScreen.screens {
            if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                names[number.uint32Value] = screen.localizedName
            }
        }
        return names
    }
    return ids.prefix(Int(count)).map { id in
        let bounds = CGDisplayBounds(id)
        let pixels = CGDisplayCopyDisplayMode(id).map { Double($0.pixelWidth) } ?? Double(CGDisplayPixelsWide(id))
        return ["id": id, "name": names[id] ?? "Display \(id)", "main": CGDisplayIsMain(id) != 0,
                "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height,
                "scale": bounds.width > 0 ? pixels / bounds.width : 1]
    }
}

func encodePNG(_ image: CGImage) throws -> String {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
        throw Failure(message: "encode-failed")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw Failure(message: "encode-failed") }
    return (data as Data).base64EncodedString()
}

func capture(_ display: CGDirectDisplayID, width: Int, height: Int) throws -> [String: Any] {
    guard #available(macOS 14.0, *) else { throw Failure(message: "capture-requires-macos-14") }
    guard CGPreflightScreenCaptureAccess() else { throw Failure(message: "screen-recording-denied") }
    var captured: CGImage?
    var failure: String?
    let done = DispatchSemaphore(value: 0)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
        guard let target = content?.displays.first(where: { $0.displayID == display }) else {
            failure = error == nil ? "display-not-found" : "capture-failed"
            done.signal()
            return
        }
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = true
        SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: target, excludingWindows: []),
                                         configuration: configuration) { image, _ in
            captured = image
            if image == nil { failure = "capture-failed" }
            done.signal()
        }
    }
    guard done.wait(timeout: .now() + 15) == .success else { throw Failure(message: "capture-timed-out") }
    guard let image = captured else { throw Failure(message: failure ?? "capture-failed") }
    return ["data": try encodePNG(image), "width": image.width, "height": image.height]
}

func context() -> [String: Any] {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    var result: [String: Any] = [
        "screenLocked": session?["CGSSessionScreenIsLocked"] as? Bool ?? false,
        "secureInput": IsSecureEventInputEnabled(),
    ]
    if let app = NSWorkspace.shared.frontmostApplication {
        result["app"] = ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier]
        if AXIsProcessTrusted() {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(element, 0.2)
            var window: CFTypeRef?
            var title: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
               let window, CFGetTypeID(window) == AXUIElementGetTypeID(),
               AXUIElementCopyAttributeValue(unsafeBitCast(window, to: AXUIElement.self), kAXTitleAttribute as CFString, &title) == .success,
               let title = title as? String {
                result["windowTitle"] = String(title.prefix(500))
            }
        }
    }
    return result
}

func post(_ event: CGEvent?) throws {
    guard AXIsProcessTrusted() else { throw Failure(message: "accessibility-denied") }
    guard let event else { throw Failure(message: "event-failed") }
    event.post(tap: .cghidEventTap)
}

func mouseTypes(_ button: String) -> (down: CGEventType, up: CGEventType, drag: CGEventType, button: CGMouseButton) {
    switch button {
    case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
    case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
    }
}

func input(_ request: [String: Any]) throws {
    let point = CGPoint(x: request["x"] as? Double ?? 0, y: request["y"] as? Double ?? 0)
    switch request["kind"] as? String {
    case "move":
        if let button = request["dragging"] as? String {
            let types = mouseTypes(button)
            try post(CGEvent(mouseEventSource: source, mouseType: types.drag, mouseCursorPosition: point, mouseButton: types.button))
        } else {
            try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
        }
    case "button":
        let button = request["button"] as? String ?? "left"
        let down = request["down"] as? Bool == true
        let types = mouseTypes(button)
        let event = CGEvent(mouseEventSource: source, mouseType: down ? types.down : types.up, mouseCursorPosition: point, mouseButton: types.button)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(request["clicks"] as? Int ?? 1))
        try post(event)
        if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
    case "scroll":
        try post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
                         wheel1: Int32(request["dy"] as? Int ?? 0), wheel2: Int32(request["dx"] as? Int ?? 0), wheel3: 0))
    case "key":
        let code = CGKeyCode(request["code"] as? Int ?? 0)
        let down = request["down"] as? Bool == true
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        event?.flags = CGEventFlags(rawValue: UInt64(request["flags"] as? Int ?? 0))
        try post(event)
        if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
    case "text":
        let units = Array((request["text"] as? String ?? "").utf16)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            event?.flags = []
            event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            try post(event)
        }
    default: throw Failure(message: "unknown-input")
    }
    // Apps drop synthetic events that arrive faster than they read them.
    usleep(request["kind"] as? String == "move" ? 4_000 : 12_000)
}

func applicationURL(_ name: String) -> URL? {
    if let running = NSWorkspace.shared.runningApplications.first(where: {
        $0.bundleIdentifier == name || $0.localizedName == name
    }), let url = running.bundleURL { return url }
    if name.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return url }
    let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
    for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities", home] {
        let url = URL(fileURLWithPath: folder).appendingPathComponent("\(name).app")
        if FileManager.default.fileExists(atPath: url.path) { return url }
    }
    return nil
}

func activate(_ name: String) throws {
    guard let url = applicationURL(name) else { throw Failure(message: "app-not-found") }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    var failed = false
    let done = DispatchSemaphore(value: 0)
    // Launch Services activates the app even though this helper is never the active app.
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
        failed = error != nil
        done.signal()
    }
    guard done.wait(timeout: .now() + 15) == .success, !failed else { throw Failure(message: "activate-failed") }
}

func openSettings(_ permission: String) {
    if permission == "screen-recording" {
        _ = CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    } else {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
}

func handle(_ request: [String: Any]) throws -> Any {
    switch request["op"] as? String {
    case "permissions":
        return ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    case "open-settings": openSettings(request["permission"] as? String ?? ""); return NSNull()
    case "displays": return displays()
    case "context": return context()
    case "capture":
        return try capture(CGDirectDisplayID(request["display"] as? Int ?? 0),
                           width: request["width"] as? Int ?? 0, height: request["height"] as? Int ?? 0)
    case "input": try input(request); return NSNull()
    case "activate": try activate(request["app"] as? String ?? ""); return NSNull()
    default: throw Failure(message: "unknown-op")
    }
}

/// The shell went away without stopping: leave nothing pressed.
func releaseHeld() {
    for button in heldButtons {
        let types = mouseTypes(button)
        let location = CGEvent(source: nil)?.location ?? .zero
        CGEvent(mouseEventSource: source, mouseType: types.up, mouseCursorPosition: location, mouseButton: types.button)?.post(tap: .cghidEventTap)
    }
    for key in heldKeys {
        CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap)
    }
}

NSApplication.shared.setActivationPolicy(.prohibited)
Thread.detachNewThread {
    while let line = readLine() {
        guard line.utf8.count <= 64 * 1024, let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? UInt64 else { continue }
        do { emit(["id": id, "result": try handle(request)]) }
        catch let failure as Failure { emit(["id": id, "error": failure.message]) }
        catch { emit(["id": id, "error": "failed"]) }
    }
    releaseHeld()
    exit(0)
}
NSApplication.shared.run()
