import AppKit
import ApplicationServices

let defaultShortcut: [String: Any] = ["kind": "both-shift-keys"]

func eligibleWindow(_ window: [String: Any], pid: Int32, ownPID: Int32) -> Bool {
    guard pid != ownPID, (window[kCGWindowOwnerPID as String] as? Int32) == pid,
          (window[kCGWindowLayer as String] as? Int) == 0,
          (window[kCGWindowIsOnscreen as String] as? Bool) == true,
          let id = window[kCGWindowNumber as String] as? Int, id > 0,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double
    else { return false }
    return width > 1 && height > 1
}

let namedKeys: [UInt16: String] = [36: "enter", 48: "tab", 49: "space", 51: "backspace", 53: "escape", 117: "delete", 123: "arrowleft", 124: "arrowright", 125: "arrowdown", 126: "arrowup"]
func supportedShortcut(_ shortcut: [String: Any]) -> Bool {
    if let kind = shortcut["kind"] as? String {
        return kind == "both-shift-keys" || (kind == "modifier-pair" && ["shift", "meta", "control", "alt"].contains(shortcut["modifier"] as? String ?? ""))
    }
    guard let key = shortcut["key"] as? String, key.count == 1 || namedKeys.values.contains(key.lowercased()) else { return false }
    return ["metaKey", "modKey", "ctrlKey", "shiftKey", "altKey"].contains { shortcut[$0] as? Bool == true }
}

func matchesShortcut(_ shortcut: [String: Any], flags: UInt, key: String?, repeatKey: Bool) -> Bool {
    if repeatKey { return false }
    if let kind = shortcut["kind"] as? String {
        let modifier = kind == "both-shift-keys" ? "shift" : shortcut["modifier"] as? String ?? ""
        let masks: [String: (UInt, UInt)] = ["shift": (0x2, 0x4), "control": (0x1, 0x2000), "alt": (0x20, 0x40), "meta": (0x8, 0x10)]
        guard let (left, right) = masks[modifier] else { return false }
        return flags & left != 0 && flags & right != 0
    }
    guard let key, let configured = shortcut["key"] as? String, key.lowercased() == configured.lowercased() else { return false }
    let command = (shortcut["metaKey"] as? Bool == true) || (shortcut["modKey"] as? Bool == true)
    return (flags & NSEvent.ModifierFlags.command.rawValue != 0) == command
        && (flags & NSEvent.ModifierFlags.control.rawValue != 0) == (shortcut["ctrlKey"] as? Bool == true)
        && (flags & NSEvent.ModifierFlags.shift.rawValue != 0) == (shortcut["shiftKey"] as? Bool == true)
        && (flags & NSEvent.ModifierFlags.option.rawValue != 0) == (shortcut["altKey"] as? Bool == true)
        && (command || flags & 0xE0000 != 0)
}

func captureAllowed(enabled: Bool, suppressed: Bool, busy: Bool, screenRecording: Bool) -> Bool {
    enabled && !suppressed && !busy && screenRecording
}

func captureRecord(id: String, data: Data, source: [String: Any]) -> [String: Any]? {
    guard validatePNG(data), let image = NSBitmapImageRep(data: data), image.pixelsWide > 0, image.pixelsHigh > 0 else { return nil }
    return ["id": id, "name": "SnapShot-\(id).png", "mimeType": "image/png", "sizeBytes": data.count,
        "source": source, "dataUrl": "data:image/png;base64," + data.base64EncodedString()]
}

func validatePNG(_ data: Data) -> Bool {
    data.count <= 32 * 1024 * 1024 && data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10])
}

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

final class SnapShots {
    var settings: [String: Any] = [:]
    var pending: [[String: Any]] = []
    var message: String?
    var suppressed = false
    var held = false
    var capturing = false
    var monitor: Any?
    let ownPID: Int32
    let fallbackRussian: Bool
    var ru: Bool { (settings["uiLanguage"] as? String).map { $0 == "ru" } ?? fallbackRussian }
    init(ownPID: Int32, ru: Bool) { self.ownPID = ownPID; self.fallbackRussian = ru }
    func text(_ en: String, _ ru: String) -> String { self.ru ? ru : en }
    var shortcut: [String: Any] { settings["snapShotShortcut"] as? [String: Any] ?? defaultShortcut }
    var enabled: Bool { settings["snapShotEnabled"] as? Bool == true }
    func event(_ type: String, _ id: String? = nil) {
        var value: [String: Any] = ["type": type]
        if let id { value["id"] = id }
        emit(["event": value])
    }
    func installMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        held = false
        guard enabled, supportedShortcut(shortcut), AXIsProcessTrusted() else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown, .keyUp]) { [weak self] event in
            guard let self else { return }
            let match = matchesShortcut(self.shortcut, flags: event.modifierFlags.rawValue,
                key: event.type == .keyDown ? (namedKeys[event.keyCode] ?? event.charactersIgnoringModifiers) : nil, repeatKey: event.type == .keyDown && event.isARepeat)
            if match && !self.held && !self.suppressed { self.capture() }
            self.held = match
        }
    }
    func state() -> [String: Any] {
        let screen = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrusted()
        // Permission may have been granted in System Settings since the last request.
        if enabled && accessibility && monitor == nil { installMonitor() }
        return ["mode": "direct", "shortcut": shortcut,
            "shortcutRegistered": enabled && accessibility && monitor != nil, "shortcutCanRetry": true,
            "shortcutMessage": accessibility ? NSNull() : text("Allow Accessibility to use the global shortcut.", "Разрешите универсальный доступ для глобального сочетания клавиш.") as Any,
            "macPermissions": ["screenRecording": screen, "accessibility": accessibility],
            "message": message as Any? ?? NSNull()]
    }
    func accessibleText(_ pid: Int32) -> String? {
        guard settings["snapShotIncludeAccessibility"] as? Bool == true, AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        var parts: [String] = []
        var remaining = 80
        let deadline = Date().addingTimeInterval(0.25)
        func walk(_ node: AXUIElement, _ depth: Int) {
            guard depth < 8, remaining > 0, Date() < deadline else { return }
            AXUIElementSetMessagingTimeout(node, 0.05)
            remaining -= 1
            for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                guard Date() < deadline else { return }
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(node, attribute as CFString, &value) == .success,
                   let string = value as? String, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    parts.append(String(string.prefix(1000)))
                }
            }
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children) == .success,
               let nodes = children as? [AXUIElement] {
                for child in nodes.prefix(40) { walk(child, depth + 1) }
            }
        }
        walk(unsafeBitCast(focused, to: AXUIElement.self), 0)
        let result = String(parts.joined(separator: "\n").prefix(12000)).trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }
    func capture() {
        guard enabled, !suppressed, !capturing else { return }
        message = nil
        guard captureAllowed(enabled: enabled, suppressed: suppressed, busy: capturing, screenRecording: CGPreflightScreenCaptureAccess()) else {
            message = text("Screen Recording permission denied. Allow Gustaf in System Settings.", "Нет разрешения на запись экрана. Разрешите Gustaf доступ в системных настройках.")
            event("failed"); return
        }
        guard pending.count < 8 else {
            message = text("Attach or remove pending snapshots first.", "Сначала добавьте или удалите ожидающие снимки.")
            event("failed"); return
        }
        guard let app = NSWorkspace.shared.frontmostApplication,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let window = windows.first(where: { eligibleWindow($0, pid: app.processIdentifier, ownPID: ownPID) }),
              let windowID = window[kCGWindowNumber as String] as? Int else {
            message = text("Capture cancelled: no active external window.", "Снимок отменён: нет активного окна другого приложения.")
            event("failed"); return
        }
        let id = UUID().uuidString.lowercased()
        let pid = app.processIdentifier
        let appName = (app.localizedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var source: [String: Any] = ["kind": "snap-shot", "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "appName": String((appName.isEmpty ? "Application" : appName).prefix(255)),
            "windowTitle": String((window[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(1000))]
        if let identifier = app.bundleIdentifier { source["appIdentifier"] = String(identifier.prefix(255)) }
        if let text = accessibleText(pid) { source["accessibleText"] = text }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            message = text("Capture cancelled: the active app changed.", "Снимок отменён: активное приложение изменилось.")
            event("failed"); return
        }
        capturing = true
        event("requested", id)
        let capturedSource = source
        DispatchQueue.global(qos: .userInitiated).async {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gustaf-snapshot-\(id)")
            var data: Data?
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                defer { try? FileManager.default.removeItem(at: directory) }
                let output = directory.appendingPathComponent("window.png")
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                process.arguments = ["-l", String(windowID), "-o", "-x", "-t", "png", output.path]
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                try process.run()
                let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 15, execute: timer)
                process.waitUntilExit()
                timer.cancel()
                if process.terminationStatus == 0,
                   let attributes = try? FileManager.default.attributesOfItem(atPath: output.path),
                   let size = attributes[.size] as? Int, size <= 32 * 1024 * 1024 {
                    data = try Data(contentsOf: output)
                }
            } catch {}
            let result = data
            DispatchQueue.main.async {
                self.capturing = false
                guard self.enabled, let result, let record = captureRecord(id: id, data: result, source: capturedSource) else {
                    self.message = self.text("Capture cancelled or unavailable. Try again.", "Снимок отменён или недоступен. Повторите попытку.")
                    self.event("failed", id); return
                }
                self.pending.append(record)
                self.event("ready", id)
            }
        }
    }
    func handle(_ request: [String: Any]) throws -> Any {
        let action = request["action"] as? String ?? ""
        let input = request["input"] as? [String: Any] ?? [:]
        switch action {
        case "state": return state()
        case "configure":
            settings = input
            message = nil
            installMonitor()
            event("shortcut-changed")
        case "permissions":
            _ = CGRequestScreenCaptureAccess()
            if input["includeAccessibility"] as? Bool == true || enabled {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            }
            installMonitor()
        case "setup":
            message = nil
            switch input["action"] as? String {
            case "test-mac-capture": capture()
            case "allow-screen-recording":
                _ = CGRequestScreenCaptureAccess()
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
            case "allow-accessibility":
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
            case "retry-shortcut":
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                installMonitor()
            default: throw NSError(domain: "Unsupported setup action", code: 1)
            }
        case "suppress": suppressed = input["suppressed"] as? Bool == true
        case "list": return pending.map { item in item.filter { $0.key != "dataUrl" } }
        case "read":
            guard let item = pending.first(where: { $0["id"] as? String == input["id"] as? String }) else {
                throw NSError(domain: "Unknown snapshot", code: 1)
            }
            return item
        case "acknowledge": pending.removeAll { $0["id"] as? String == input["id"] as? String }
        case "check":
            let supported = supportedShortcut(input["shortcut"] as? [String: Any] ?? [:])
            return ["available": supported, "message": supported ? NSNull() : text("This shortcut is unavailable in Gustaf. Choose letters, numbers or modifier pairs.", "Это сочетание недоступно в Gustaf. Выберите буквы, цифры или пару модификаторов.") as Any]
        case "animation": break
        default: throw NSError(domain: "Unknown snapshot command", code: 1)
        }
        return NSNull()
    }
}

if CommandLine.arguments.contains("--self-test") {
    let fixture: [String: Any] = [kCGWindowOwnerPID as String: Int32(7), kCGWindowLayer as String: 0,
        kCGWindowIsOnscreen as String: true, kCGWindowNumber as String: 42,
        kCGWindowBounds as String: ["Width": 600.0, "Height": 400.0]]
    precondition(eligibleWindow(fixture, pid: 7, ownPID: 8))
    precondition(!eligibleWindow(fixture, pid: 7, ownPID: 7))
    precondition(!eligibleWindow(fixture, pid: 9, ownPID: 8))
    precondition(!eligibleWindow(fixture.merging([kCGWindowLayer as String: 1]) { _, new in new }, pid: 7, ownPID: 8))
    precondition(!eligibleWindow(fixture.merging([kCGWindowNumber as String: 0]) { _, new in new }, pid: 7, ownPID: 8))
    precondition(!eligibleWindow(fixture.merging([kCGWindowIsOnscreen as String: false]) { _, new in new }, pid: 7, ownPID: 8))
    precondition(!supportedShortcut(["key": "f99", "metaKey": true]))
    precondition(supportedShortcut(["key": "k", "metaKey": true]))
    precondition(!supportedShortcut(["key": "k"]))
    precondition(matchesShortcut(defaultShortcut, flags: 6, key: nil, repeatKey: false))
    precondition(!matchesShortcut(defaultShortcut, flags: 2, key: nil, repeatKey: false))
    precondition(!matchesShortcut(defaultShortcut, flags: 6, key: nil, repeatKey: true))
    precondition(!validatePNG(Data("not an image".utf8)))
    let service = SnapShots(ownPID: 8, ru: true)
    let listed = try service.handle(["action": "list"]) as? [[String: Any]]
    precondition(listed?.isEmpty == true)
    do { _ = try service.handle(["action": "read", "input": ["id": "../secret"]]); preconditionFailure() } catch {}
    do { _ = try service.handle(["action": "arbitrary-command"]); preconditionFailure() } catch {}
    precondition(!captureAllowed(enabled: true, suppressed: false, busy: false, screenRecording: false))
    precondition(!captureAllowed(enabled: false, suppressed: false, busy: false, screenRecording: true))
    precondition(!captureAllowed(enabled: true, suppressed: true, busy: false, screenRecording: true))
    precondition(!captureAllowed(enabled: true, suppressed: false, busy: true, screenRecording: true))
    precondition(captureAllowed(enabled: true, suppressed: false, busy: false, screenRecording: true))
    let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBqkAAAAASUVORK5CYII=")!
    let record = captureRecord(id: "abc", data: png, source: ["appName": "Fixture"] )!
    service.pending.append(record)
    let read = try service.handle(["action": "read", "input": ["id": "abc"]]) as! [String: Any]
    precondition(read["dataUrl"] as? String == "data:image/png;base64," + png.base64EncodedString())
    let metadata = try service.handle(["action": "list"]) as! [[String: Any]]
    precondition(metadata[0]["dataUrl"] == nil)
    _ = try service.handle(["action": "acknowledge", "input": ["id": "abc"]])
    precondition(service.pending.isEmpty)
    print("SnapShot fixtures: selection, modifier guards, invalid PNG and protocol passed")
} else {
    let ownPID = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? -1
    guard ownPID > 0 else { exit(1) }
    NSApplication.shared.setActivationPolicy(.prohibited)
    let service = SnapShots(ownPID: ownPID, ru: CommandLine.arguments.contains("ru"))
    DispatchQueue.global().async {
        while let line = readLine() {
            guard line.utf8.count <= 1024 * 1024, let data = line.data(using: .utf8),
                  let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = request["id"] as? UInt64 else { continue }
            DispatchQueue.main.async {
                do { emit(["id": id, "result": try service.handle(request)]) }
                catch { emit(["id": id, "error": error.localizedDescription]) }
            }
        }
        exit(0)
    }
    NSApplication.shared.run()
}
