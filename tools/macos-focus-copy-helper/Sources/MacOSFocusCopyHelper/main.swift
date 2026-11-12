import AppKit
import ApplicationServices
import Carbon
import Darwin
import Dispatch
import Foundation

@_silgen_name("RunApplicationEventLoop")
private func carbonRunApplicationEventLoop()

private enum CopyMethod: String {
    case browserEditorApi
    case browserCdp
    case browserExtensionCache
    case browserJavaScript
    case axValue
    case stringForRange
    case attributedStringForRange
    case textMarkerRange
    case selectedText
    case keyboardCopy
    case keyboardShortcut
}

private struct CopyResult {
    let method: CopyMethod
    let text: String
    let sourceURL: String?

    var characterCount: Int {
        text.count
    }

    init(method: CopyMethod, text: String, sourceURL: String? = nil) {
        self.method = method
        self.text = text
        self.sourceURL = sourceURL
    }
}

private struct BrowserFocusedTextResult: Decodable {
    let ok: Bool
    let text: String?
    let reason: String?
    let kind: String?
    let tagName: String?
    let length: Int?
}

private struct BrowserFocusCachePayload: Codable {
    let schemaVersion: Int
    let source: String
    let url: String?
    let title: String?
    let frameUrl: String?
    let text: String?
    let kind: String?
    let tagName: String?
    let isPassword: Bool
    let selectionStart: Int?
    let selectionEnd: Int?
    let textLength: Int?
    let pageTimestampMs: Double?
    let receivedAt: TimeInterval
}

private struct BrowserFocusCacheNativeMessage: Decodable {
    let type: String
    let source: String?
    let requestId: String?
    let ok: Bool?
    let method: String?
    let restored: Bool?
    let error: String?
    let elapsedMs: Int?
    let supportsCdp: Bool?
    let url: String?
    let title: String?
    let frameUrl: String?
    let text: String?
    let kind: String?
    let tagName: String?
    let isPassword: Bool?
    let selectionStart: Int?
    let selectionEnd: Int?
    let textLength: Int?
    let timestampMs: Double?
}

private struct BrowserCdpCopyRequest: Codable {
    let schemaVersion: Int
    let type: String
    let requestId: String
    let targetBundleId: String?
    let deadlineMs: Int
    let createdAtMs: Int64
}

private struct BrowserCdpCopyResponse: Codable {
    let schemaVersion: Int
    let type: String
    let requestId: String
    let ok: Bool
    let method: String?
    let restored: Bool?
    let error: String?
    let url: String?
    let title: String?
    let frameUrl: String?
    let text: String?
    let kind: String?
    let tagName: String?
    let textLength: Int?
    let elapsedMs: Int?
    let receivedAtMs: Int64
}

private struct FocusCopyResultEvent: Encodable {
    let type: String
    let ok: Bool
    let text: String?
    let method: String?
    let characterCount: Int
    let appName: String?
    let bundleId: String?
    let url: String?
    let error: String?
    let elapsedMs: Int
}

private enum FocusCopyError: Error, CustomStringConvertible {
    case accessibilityNotTrusted
    case focusedElementUnavailable(AXError)
    case unsupportedFocusedElement
    case emptyPasteboardWriteFailed
    case pasteboardWriteFailed
    case hotkeyRegistrationFailed(OSStatus)
    case hotkeyHandlerInstallationFailed(OSStatus)

    var description: String {
        switch self {
        case .accessibilityNotTrusted:
            return "Accessibility permission is not granted."
        case .focusedElementUnavailable(let error):
            return "Focused accessibility element is unavailable: \(error)."
        case .unsupportedFocusedElement:
            return "Focused element does not expose readable text."
        case .emptyPasteboardWriteFailed:
            return "Failed to clear pasteboard for empty text."
        case .pasteboardWriteFailed:
            return "Failed to write text to pasteboard."
        case .hotkeyRegistrationFailed(let status):
            return "Failed to register focus-copy hotkey. OSStatus: \(status)."
        case .hotkeyHandlerInstallationFailed(let status):
            return "Failed to install Ctrl+Shift+A hotkey handler. OSStatus: \(status)."
        }
    }
}

private struct AXTextRange {
    let location: Int
    let length: Int

    var cfRange: CFRange {
        CFRange(location: location, length: length)
    }
}

private final class CopyAttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.lock()
        defer {
            lock.unlock()
        }
        value += 1
        return value
    }
}

private let copyAttemptCounter = CopyAttemptCounter()

private final class BrowserCdpCapabilityState: @unchecked Sendable {
    private let lock = NSLock()
    private var ready = false

    func markReady() {
        lock.lock()
        ready = true
        lock.unlock()
    }

    func isReady() -> Bool {
        lock.lock()
        defer {
            lock.unlock()
        }
        return ready
    }
}

private let browserCdpCapabilityState = BrowserCdpCapabilityState()

private func nextCopyAttemptID() -> Int {
    copyAttemptCounter.next()
}

private func logCopy(_ attemptID: Int, _ message: String) {
    log("[copy:\(attemptID)] \(message)")
}

private func describe(_ range: AXTextRange?) -> String {
    guard let range else {
        return "nil"
    }
    return "{location=\(range.location), length=\(range.length)}"
}

private func axErrorName(_ error: AXError) -> String {
    switch error {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .invalidUIElementObserver: return "invalidUIElementObserver"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notificationUnsupported: return "notificationUnsupported"
    case .notImplemented: return "notImplemented"
    case .notificationAlreadyRegistered: return "notificationAlreadyRegistered"
    case .notificationNotRegistered: return "notificationNotRegistered"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
    case .notEnoughPrecision: return "notEnoughPrecision"
    @unknown default: return "unknown(\(error.rawValue))"
    }
}

private func cfTypeDescription(_ value: CFTypeRef?) -> String {
    guard let value else {
        return "nil"
    }

    if let string = value as? String {
        return "String(count=\(string.count))"
    }
    if let number = value as? NSNumber {
        return "NSNumber(\(number))"
    }
    if CFGetTypeID(value) == AXValueGetTypeID() {
        return "AXValue"
    }
    if CFGetTypeID(value) == AXUIElementGetTypeID() {
        return "AXUIElement"
    }
    if CFGetTypeID(value) == AXTextMarkerGetTypeID() {
        return "AXTextMarker(length=\(AXTextMarkerGetLength(value as! AXTextMarker)))"
    }
    if CFGetTypeID(value) == AXTextMarkerRangeGetTypeID() {
        return "AXTextMarkerRange"
    }
    return "CFTypeID(\(CFGetTypeID(value)))"
}

private func textDebugSummary(_ text: String) -> String {
    let scalarCount = text.unicodeScalars.count
    let newlineCount = text.filter { $0 == "\n" }.count
    let shouldLogPreview = ProcessInfo.processInfo.environment["FOCUS_COPY_LOG_TEXT"] == "1"
    guard shouldLogPreview else {
        return "chars=\(text.count), scalars=\(scalarCount), newlines=\(newlineCount), preview=<disabled>"
    }

    let preview = text
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\t", with: "\\t")
        .prefix(160)
    return "chars=\(text.count), scalars=\(scalarCount), newlines=\(newlineCount), preview=\"\(preview)\""
}

private func deepAXFocusedDescendantSearchEnabled() -> Bool {
    ProcessInfo.processInfo.environment["FOCUS_COPY_DEEP_AX_SEARCH"] == "1"
}

private func learnFastKeyboardFallbackEnabled() -> Bool {
    ProcessInfo.processInfo.environment["FOCUS_COPY_LEARN_FAST_KEYBOARD"] == "1"
}

private func visibleKeyboardShortcutFallbackEnabled() -> Bool {
    ProcessInfo.processInfo.environment["FOCUS_COPY_ALLOW_VISIBLE_FALLBACK"] == "1"
}

/// Browser CDP fallback is on by default. Set FOCUS_COPY_ENABLE_BROWSER_CDP=0 to disable it.
private func browserCdpDebuggerEnabled() -> Bool {
    ProcessInfo.processInfo.environment["FOCUS_COPY_ENABLE_BROWSER_CDP"] != "0"
}

private let silentDebuggerFlag = "--silent-debugger-extension-api"
nonisolated(unsafe) private var silentDebuggerFlagCache: [pid_t: Bool] = [:]

/// chrome.debugger shows a visible "started debugging this browser" bar unless the browser
/// was launched with --silent-debugger-extension-api. The CDP path is only allowed for such
/// browsers, so the bar never appears.
private func browserLaunchedWithSilentDebugger(pid: pid_t) -> Bool {
    if let cached = silentDebuggerFlagCache[pid] {
        return cached
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-o", "args=", "-p", String(pid)]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice

    var result = false
    do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let args = String(data: data, encoding: .utf8) ?? ""
        result = args.contains(silentDebuggerFlag)
    } catch {
        result = false
    }

    silentDebuggerFlagCache[pid] = result
    return result
}

private func monacoBrowserCacheEnabled() -> Bool {
    ProcessInfo.processInfo.environment["FOCUS_COPY_ENABLE_MONACO_CACHE"] == "1"
}

private final class KeyboardShortcutFastPathCache: @unchecked Sendable {
    private let lock = NSLock()
    private var bundleIDs: Set<String>

    init() {
        let configured = ProcessInfo.processInfo.environment["FOCUS_COPY_FAST_KEYBOARD_BUNDLES"] ?? ""
        bundleIDs = Set(
            configured
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        )
    }

    func contains(_ bundleID: String) -> Bool {
        lock.lock()
        defer {
            lock.unlock()
        }
        return bundleIDs.contains(bundleID)
    }

    func insert(_ bundleID: String) {
        lock.lock()
        defer {
            lock.unlock()
        }
        bundleIDs.insert(bundleID)
    }
}

private final class ManualAccessibilityActivationCache: @unchecked Sendable {
    private let lock = NSLock()
    private var attemptedPids = Set<pid_t>()

    func markAttemptedIfNeeded(_ pid: pid_t) -> Bool {
        lock.lock()
        defer {
            lock.unlock()
        }

        if attemptedPids.contains(pid) {
            return false
        }

        attemptedPids.insert(pid)
        return true
    }
}

private let keyboardShortcutFastPathCache = KeyboardShortcutFastPathCache()
private let manualAccessibilityActivationCache = ManualAccessibilityActivationCache()

private final class FocusTextCopier {
    func copyFocusedTextToPasteboard() throws -> CopyResult {
        let attemptID = nextCopyAttemptID()
        logCopy(attemptID, "BEGIN copyFocusedTextToPasteboard on mainThread=\(Thread.isMainThread)")
        logCopy(attemptID, "frontmost=\(frontmostApplicationSummary())")

        do {
            let result = try copyFocusedTextToPasteboard(attemptID: attemptID)
            logCopy(attemptID, "END success method=\(result.method.rawValue), chars=\(result.characterCount)")
            return result
        } catch {
            logCopy(attemptID, "END failure error=\(error)")
            throw error
        }
    }

    func copyFocusedEditorApiTextToPasteboard() throws -> CopyResult {
        let attemptID = nextCopyAttemptID()
        logCopy(attemptID, "BEGIN copyFocusedEditorApiTextToPasteboard on mainThread=\(Thread.isMainThread)")
        logCopy(attemptID, "frontmost=\(frontmostApplicationSummary())")

        do {
            let result = try copyFocusedEditorApiTextToPasteboard(attemptID: attemptID)
            logCopy(attemptID, "END success method=\(result.method.rawValue), chars=\(result.characterCount)")
            return result
        } catch {
            logCopy(attemptID, "END failure error=\(error)")
            throw error
        }
    }

    private func copyFocusedEditorApiTextToPasteboard(attemptID: Int) throws -> CopyResult {
        if let result = try copyViaBrowserEditorApiIfSupported(attemptID: attemptID) {
            return result
        }

        if let result = try copyViaBrowserEditorApiCacheIfFresh(attemptID: attemptID) {
            return result
        }

        logCopy(attemptID, "all focused editor API strategies failed")
        throw FocusCopyError.unsupportedFocusedElement
    }

    private func copyFocusedTextToPasteboard(attemptID: Int) throws -> CopyResult {
        let trusted = Self.isAccessibilityTrusted(prompt: false)
        logCopy(attemptID, "accessibility trusted=\(trusted)")
        guard trusted else {
            throw FocusCopyError.accessibilityNotTrusted
        }

        enableManualAccessibilityForFrontmostApplication(attemptID: attemptID)

        if browserCdpDebuggerEnabled() {
            if let result = try copyViaBrowserCdpIfSupported(attemptID: attemptID) {
                return result
            }
            if let result = try copyViaBrowserExtensionCacheIfFresh(attemptID: attemptID) {
                return result
            }
        } else {
            if let result = try copyViaBrowserExtensionCacheIfFresh(attemptID: attemptID) {
                return result
            }
            if let result = try copyViaBrowserCdpIfSupported(attemptID: attemptID) {
                return result
            }
        }

        if let result = try copyViaBrowserJavaScriptIfSupported(attemptID: attemptID) {
            return result
        }

        if visibleKeyboardShortcutFallbackEnabled(),
           shouldPreferKeyboardShortcutFallback(attemptID: attemptID),
           let result = try copyByKeyboardShortcuts(attemptID: attemptID) {
            return result
        }

        let element: AXUIElement
        do {
            element = try focusedElement(attemptID: attemptID)
        } catch {
            guard visibleKeyboardShortcutFallbackEnabled() else {
                logCopy(
                    attemptID,
                    "focused element unavailable; visible keyboard shortcut fallback skipped because it cannot restore original caret; set FOCUS_COPY_ALLOW_VISIBLE_FALLBACK=1 to opt in"
                )
                throw error
            }

            logCopy(attemptID, "focused element unavailable; trying visible keyboard shortcut fallback")
            if let result = try copyByKeyboardShortcuts(attemptID: attemptID) {
                rememberKeyboardShortcutFastPathForFrontmostApp(attemptID: attemptID)
                return result
            }
            throw error
        }
        logFocusedElement(element, attemptID: attemptID)

        let originalRange = selectedTextRange(for: element, attemptID: attemptID)
        logCopy(attemptID, "original selected range=\(describe(originalRange))")

        let fullRange = fullTextRange(for: element, attemptID: attemptID)
        logCopy(attemptID, "full text range=\(describe(fullRange))")

        let axValueText = readAXValueText(from: element, attemptID: attemptID)
        if let text = axValueText,
           !text.isEmpty {
            if let fullRange,
               fullRange.length > text.count {
                logCopy(
                    attemptID,
                    "AXValue looks partial; delaying fallback because fullRangeLength=\(fullRange.length), axValueChars=\(text.count), \(textDebugSummary(text))"
                )
            } else {
                logCopy(attemptID, "AXValue read succeeded with complete-looking text: \(textDebugSummary(text))")
                try writePasteboard(text, attemptID: attemptID)
                return CopyResult(method: .axValue, text: text)
            }
        }
        if axValueText != nil && axValueText?.isEmpty == true {
            logCopy(attemptID, "AXValue read returned empty text; continuing with richer text strategies before accepting empty field")
        }

        if let fullRange,
           let text = readStringForRange(from: element, range: fullRange, attemptID: attemptID) {
            logCopy(attemptID, "AXStringForRange read succeeded: \(textDebugSummary(text))")
            try writePasteboard(text, attemptID: attemptID)
            return CopyResult(method: .stringForRange, text: text)
        }

        if let fullRange,
           let text = readAttributedStringForRange(from: element, range: fullRange, attemptID: attemptID) {
            logCopy(attemptID, "AXAttributedStringForRange read succeeded: \(textDebugSummary(text))")
            try writePasteboard(text, attemptID: attemptID)
            return CopyResult(method: .attributedStringForRange, text: text)
        }

        if let text = readTextViaTextMarkers(
            from: element,
            fullRange: fullRange,
            attemptID: attemptID
        ) {
            logCopy(attemptID, "AXTextMarkerRange read succeeded: \(textDebugSummary(text))")
            try writePasteboard(text, attemptID: attemptID)
            return CopyResult(method: .textMarkerRange, text: text)
        }

        let selectedRangeSettable = isSelectedTextRangeSettable(for: element, attemptID: attemptID)
        logCopy(attemptID, "AXSelectedTextRange settable=\(selectedRangeSettable)")

        if let fullRange,
           selectedRangeSettable,
           let text = try readTextBySelectingAll(
            element: element,
            fullRange: fullRange,
            restore: originalRange,
            attemptID: attemptID
           ) {
            logCopy(attemptID, "AXSelectedText read succeeded: \(textDebugSummary(text))")
            try writePasteboard(text, attemptID: attemptID)
            return CopyResult(method: .selectedText, text: text)
        }

        if let fullRange,
           selectedRangeSettable,
           let text = try copyBySelectingAllAndSendingKeyboardCopy(
            element: element,
            fullRange: fullRange,
            restore: originalRange,
            attemptID: attemptID
           ) {
            logCopy(attemptID, "keyboard copy fallback succeeded: \(textDebugSummary(text))")
            return CopyResult(method: .keyboardCopy, text: text)
        }

        if let text = axValueText {
            if !text.isEmpty,
               let fullRange,
               fullRange.length > text.count {
                logCopy(
                    attemptID,
                    "refusing partial AXValue after richer strategies failed; fullRangeLength=\(fullRange.length), axValueChars=\(text.count)"
                )
            } else {
                logCopy(attemptID, "accepting AXValue after all richer strategies failed: \(textDebugSummary(text))")
                try writePasteboard(text, attemptID: attemptID)
                return CopyResult(method: .axValue, text: text)
            }
        }

        if !visibleKeyboardShortcutFallbackEnabled() {
            logCopy(
                attemptID,
                "visible keyboard shortcut fallback skipped because it cannot restore original caret; set FOCUS_COPY_ALLOW_VISIBLE_FALLBACK=1 to opt in"
            )
        }

        logCopy(attemptID, "all caret-safe copy strategies failed")
        throw FocusCopyError.unsupportedFocusedElement
    }

    private func shouldPreferKeyboardShortcutFallback(attemptID: Int) -> Bool {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return false
        }

        let bundleID = app.bundleIdentifier ?? ""
        let shouldPrefer = keyboardShortcutFastPathCache.contains(bundleID)
        if shouldPrefer {
            logCopy(
                attemptID,
                "using learned fast keyboard-shortcut path for bundle=\(bundleID), pid=\(app.processIdentifier)"
            )
        }

        return shouldPrefer
    }

    private func copyViaBrowserCdpIfSupported(attemptID: Int) throws -> CopyResult? {
        guard browserCdpDebuggerEnabled() else {
            logCopy(attemptID, "browser CDP debugger path disabled by FOCUS_COPY_ENABLE_BROWSER_CDP=0")
            return nil
        }

        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "browser CDP path skipped because frontmostApplication=nil")
            return nil
        }

        guard let browser = browserAutomationTarget(for: app),
              browser.family == .chromium else {
            logCopy(
                attemptID,
                "browser CDP path skipped for bundle=\(app.bundleIdentifier ?? "nil"), name=\(app.localizedName ?? "nil")"
            )
            return nil
        }

        guard browserLaunchedWithSilentDebugger(pid: app.processIdentifier) else {
            logCopy(attemptID, "browser CDP path skipped: pid=\(app.processIdentifier) was not launched with \(silentDebuggerFlag) (would show a debugger bar); run pnpm copy-helper:brave:restart-cdp")
            return nil
        }

        guard isBrowserCdpHostPresent(targetBundleId: app.bundleIdentifier, maxAgeSeconds: 3) else {
            logCopy(attemptID, "browser CDP path skipped because native host is not active for bundle=\(app.bundleIdentifier ?? "nil")")
            return nil
        }

        let pasteboard = NSPasteboard.general
        let previousChangeCount = pasteboard.changeCount
        let previousText = pasteboard.string(forType: .string)
        logCopy(
            attemptID,
            "browser CDP path begin appName=\(browser.applicationName), bundle=\(app.bundleIdentifier ?? "nil"), previousChangeCount=\(previousChangeCount)"
        )

        guard let response = sendBrowserCdpCopyRequest(
            targetBundleId: app.bundleIdentifier,
            deadlineMs: 700,
            attemptID: attemptID
        ) else {
            logCopy(attemptID, "browser CDP path failed because native host did not return a response")
            return nil
        }

        guard response.ok else {
            logCopy(attemptID, "browser CDP path failed error=\(response.error ?? "nil"), elapsedMs=\(response.elapsedMs ?? -1)")
            return nil
        }

        let deadline = Date().addingTimeInterval(0.25)
        var loopCount = 0
        var copiedText: String?
        repeat {
            loopCount += 1
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
            let currentText = pasteboard.string(forType: .string)
            if pasteboard.changeCount != previousChangeCount || currentText != previousText {
                copiedText = currentText
                break
            }
        } while Date() < deadline

        guard let text = copiedText,
              !text.isEmpty else {
            logCopy(
                attemptID,
                "browser CDP path produced no pasteboard text loops=\(loopCount), changeCount=\(pasteboard.changeCount), restored=\(response.restored.map(String.init) ?? "nil")"
            )
            return nil
        }

        logCopy(
            attemptID,
            "browser CDP path succeeded loops=\(loopCount), restored=\(response.restored.map(String.init) ?? "nil"), url=\(response.url ?? "nil"), \(textDebugSummary(text))"
        )
        return CopyResult(method: .browserCdp, text: text, sourceURL: response.url)
    }

    private func copyViaBrowserEditorApiIfSupported(attemptID: Int) throws -> CopyResult? {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "browser editor API path skipped because frontmostApplication=nil")
            return nil
        }

        guard let browser = browserAutomationTarget(for: app),
              browser.family == .chromium else {
            logCopy(
                attemptID,
                "browser editor API path skipped for bundle=\(app.bundleIdentifier ?? "nil"), name=\(app.localizedName ?? "nil")"
            )
            return nil
        }

        guard isBrowserCdpHostPresent(targetBundleId: app.bundleIdentifier, maxAgeSeconds: 3) else {
            logCopy(attemptID, "browser editor API path skipped because native host is not active for bundle=\(app.bundleIdentifier ?? "nil")")
            return nil
        }

        logCopy(
            attemptID,
            "browser editor API path begin appName=\(browser.applicationName), bundle=\(app.bundleIdentifier ?? "nil")"
        )

        guard let response = sendBrowserCdpCopyRequest(
            targetBundleId: app.bundleIdentifier,
            deadlineMs: 450,
            attemptID: attemptID,
            requestType: "focus-copy-editor-api-request"
        ) else {
            logCopy(attemptID, "browser editor API path failed because native host did not return a response")
            return nil
        }

        guard response.ok else {
            logCopy(attemptID, "browser editor API path failed error=\(response.error ?? "nil"), elapsedMs=\(response.elapsedMs ?? -1)")
            return nil
        }

        guard let text = response.text else {
            logCopy(attemptID, "browser editor API path returned no text kind=\(response.kind ?? "nil"), url=\(response.url ?? "nil")")
            return nil
        }

        logCopy(
            attemptID,
            "browser editor API path succeeded kind=\(response.kind ?? "nil"), tag=\(response.tagName ?? "nil"), url=\(response.url ?? "nil"), \(textDebugSummary(text))"
        )
        try writePasteboard(text, attemptID: attemptID)
        return CopyResult(method: .browserEditorApi, text: text, sourceURL: response.url)
    }

    private func sendBrowserCdpCopyRequest(
        targetBundleId: String?,
        deadlineMs: Int,
        attemptID: Int,
        requestType: String = "focus-copy-cdp-request"
    ) -> BrowserCdpCopyResponse? {
        let requestId = UUID().uuidString
        let request = BrowserCdpCopyRequest(
            schemaVersion: 1,
            type: requestType,
            requestId: requestId,
            targetBundleId: targetBundleId,
            deadlineMs: deadlineMs,
            createdAtMs: currentTimeMillis()
        )
        let requestURL = browserCdpRequestURL(requestId: requestId)
        let responseURL = browserCdpResponseURL(requestId: requestId)

        do {
            try FileManager.default.createDirectory(
                at: requestURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try FileManager.default.createDirectory(
                at: responseURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(request)
            let tempURL = requestURL.appendingPathExtension("tmp")
            try data.write(to: tempURL, options: .atomic)
            if FileManager.default.fileExists(atPath: requestURL.path) {
                try FileManager.default.removeItem(at: requestURL)
            }
            try FileManager.default.moveItem(at: tempURL, to: requestURL)
            logCopy(attemptID, "browser request written type=\(requestType), requestId=\(requestId), targetBundleId=\(targetBundleId ?? "nil")")
        } catch {
            logCopy(attemptID, "browser request write failed type=\(requestType), requestId=\(requestId), error=\(error)")
            return nil
        }

        let deadline = Date().addingTimeInterval(Double(deadlineMs + 250) / 1000.0)
        var loopCount = 0
        repeat {
            loopCount += 1
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
            guard let data = try? Data(contentsOf: responseURL) else {
                continue
            }
            do {
                let response = try JSONDecoder().decode(BrowserCdpCopyResponse.self, from: data)
                try? FileManager.default.removeItem(at: responseURL)
                logCopy(
                    attemptID,
                    "browser response read type=\(response.type), requestId=\(requestId), ok=\(response.ok), loops=\(loopCount), method=\(response.method ?? "nil"), restored=\(response.restored.map(String.init) ?? "nil")"
                )
                return response
            } catch {
                logCopy(attemptID, "browser response decode failed requestId=\(requestId), error=\(error)")
                return nil
            }
        } while Date() < deadline

        try? FileManager.default.removeItem(at: requestURL)
        logCopy(attemptID, "browser response timeout type=\(requestType), requestId=\(requestId), loops=\(loopCount)")
        return nil
    }

    private func copyViaBrowserEditorApiCacheIfFresh(attemptID: Int) throws -> CopyResult? {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "browser editor API cache skipped because frontmostApplication=nil")
            return nil
        }

        guard browserAutomationTarget(for: app) != nil else {
            logCopy(
                attemptID,
                "browser editor API cache skipped for non-browser bundle=\(app.bundleIdentifier ?? "nil")"
            )
            return nil
        }

        let cacheURL = browserFocusCacheURL()
        guard let data = try? Data(contentsOf: cacheURL) else {
            logCopy(attemptID, "browser editor API cache missing path=\(cacheURL.path)")
            return nil
        }

        let payload: BrowserFocusCachePayload
        do {
            payload = try JSONDecoder().decode(BrowserFocusCachePayload.self, from: data)
        } catch {
            logCopy(attemptID, "browser editor API cache decode failed error=\(error)")
            return nil
        }

        let ageMs = Int(Date().timeIntervalSince1970 * 1000 - payload.receivedAt * 1000)
        guard ageMs <= 2_000 else {
            logCopy(attemptID, "browser editor API cache stale ageMs=\(ageMs), source=\(payload.source)")
            return nil
        }

        guard let kind = payload.kind,
              Self.isEditorApiKind(kind) else {
            logCopy(attemptID, "browser editor API cache skipped non-editor kind=\(payload.kind ?? "nil")")
            return nil
        }

        guard !payload.isPassword else {
            logCopy(attemptID, "browser editor API cache refused password field url=\(payload.url ?? "nil")")
            return nil
        }

        guard let text = payload.text else {
            logCopy(attemptID, "browser editor API cache has no text kind=\(payload.kind ?? "nil"), source=\(payload.source)")
            return nil
        }

        logCopy(
            attemptID,
            "browser editor API cache hit ageMs=\(ageMs), source=\(payload.source), kind=\(kind), tag=\(payload.tagName ?? "nil"), url=\(payload.url ?? "nil"), \(textDebugSummary(text))"
        )
        try writePasteboard(text, attemptID: attemptID)
        return CopyResult(method: .browserEditorApi, text: text, sourceURL: payload.url)
    }

    private static func isEditorApiKind(_ kind: String) -> Bool {
        let normalized = kind.lowercased()
        return [
            "monaco",
            "codemirror",
            "ace",
            "textarea",
            "input",
            "contenteditable",
            "quill",
            "tinymce",
            "prosemirror",
            "slate",
            "lexical",
            "draft",
            "codejar",
        ].contains { normalized.contains($0) }
    }

    private func copyViaBrowserExtensionCacheIfFresh(attemptID: Int) throws -> CopyResult? {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "browser extension cache skipped because frontmostApplication=nil")
            return nil
        }

        guard browserAutomationTarget(for: app) != nil else {
            logCopy(
                attemptID,
                "browser extension cache skipped for non-browser bundle=\(app.bundleIdentifier ?? "nil")"
            )
            return nil
        }

        let cacheURL = browserFocusCacheURL()
        guard let data = try? Data(contentsOf: cacheURL) else {
            logCopy(attemptID, "browser extension cache missing path=\(cacheURL.path)")
            return nil
        }

        let payload: BrowserFocusCachePayload
        do {
            payload = try JSONDecoder().decode(BrowserFocusCachePayload.self, from: data)
        } catch {
            logCopy(attemptID, "browser extension cache decode failed error=\(error)")
            return nil
        }

        let ageMs = Int(Date().timeIntervalSince1970 * 1000 - payload.receivedAt * 1000)
        guard ageMs <= 2_000 else {
            logCopy(attemptID, "browser extension cache stale ageMs=\(ageMs), source=\(payload.source)")
            return nil
        }

        guard !payload.isPassword else {
            logCopy(attemptID, "browser extension cache refused password field url=\(payload.url ?? "nil")")
            return nil
        }

        if let kind = payload.kind,
           kind.hasPrefix("monaco-"),
           !monacoBrowserCacheEnabled() {
            logCopy(
                attemptID,
                "browser extension cache skipped Monaco snapshot kind=\(kind), url=\(payload.url ?? "nil"); set FOCUS_COPY_ENABLE_MONACO_CACHE=1 to enable adapter cache"
            )
            return nil
        }

        guard let text = payload.text else {
            logCopy(
                attemptID,
                "browser extension cache has no text kind=\(payload.kind ?? "nil"), tag=\(payload.tagName ?? "nil"), source=\(payload.source)"
            )
            return nil
        }

        logCopy(
            attemptID,
            "browser extension cache hit ageMs=\(ageMs), source=\(payload.source), kind=\(payload.kind ?? "nil"), tag=\(payload.tagName ?? "nil"), url=\(payload.url ?? "nil"), \(textDebugSummary(text))"
        )
        try writePasteboard(text, attemptID: attemptID)
        return CopyResult(method: .browserExtensionCache, text: text, sourceURL: payload.url)
    }

    private func copyViaBrowserJavaScriptIfSupported(attemptID: Int) throws -> CopyResult? {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "browser JavaScript path skipped because frontmostApplication=nil")
            return nil
        }

        guard let browser = browserAutomationTarget(for: app) else {
            logCopy(
                attemptID,
                "browser JavaScript path skipped for bundle=\(app.bundleIdentifier ?? "nil"), name=\(app.localizedName ?? "nil")"
            )
            return nil
        }

        logCopy(
            attemptID,
            "browser JavaScript path begin appName=\(browser.applicationName), bundle=\(app.bundleIdentifier ?? "nil"), family=\(browser.family)"
        )

        guard let json = runFocusedTextBrowserScript(browser: browser, attemptID: attemptID) else {
            logCopy(attemptID, "browser JavaScript path failed because AppleScript returned nil")
            return nil
        }

        guard let data = json.data(using: .utf8) else {
            logCopy(attemptID, "browser JavaScript path failed because result is not UTF-8")
            return nil
        }

        let payload: BrowserFocusedTextResult
        do {
            payload = try JSONDecoder().decode(BrowserFocusedTextResult.self, from: data)
        } catch {
            logCopy(
                attemptID,
                "browser JavaScript path failed to decode result error=\(error), rawPrefix=\(String(json.prefix(160)))"
            )
            return nil
        }

        guard payload.ok,
              let text = payload.text else {
            logCopy(
                attemptID,
                "browser JavaScript path unsupported reason=\(payload.reason ?? "nil"), kind=\(payload.kind ?? "nil"), tag=\(payload.tagName ?? "nil")"
            )
            return nil
        }

        logCopy(
            attemptID,
            "browser JavaScript path succeeded kind=\(payload.kind ?? "nil"), tag=\(payload.tagName ?? "nil"), reportedLength=\(payload.length.map(String.init) ?? "nil"), \(textDebugSummary(text))"
        )
        try writePasteboard(text, attemptID: attemptID)
        return CopyResult(method: .browserJavaScript, text: text)
    }

    private struct BrowserAutomationTarget {
        enum Family: String {
            case chromium
            case safari
        }

        let applicationName: String
        let family: Family
    }

    private func browserAutomationTarget(for app: NSRunningApplication) -> BrowserAutomationTarget? {
        switch app.bundleIdentifier {
        case "com.brave.Browser":
            return BrowserAutomationTarget(applicationName: "Brave Browser", family: .chromium)
        case "com.google.Chrome":
            return BrowserAutomationTarget(applicationName: "Google Chrome", family: .chromium)
        case "com.google.Chrome.canary":
            return BrowserAutomationTarget(applicationName: "Google Chrome Canary", family: .chromium)
        case "com.microsoft.edgemac":
            return BrowserAutomationTarget(applicationName: "Microsoft Edge", family: .chromium)
        case "com.apple.Safari":
            return BrowserAutomationTarget(applicationName: "Safari", family: .safari)
        case "com.apple.SafariTechnologyPreview":
            return BrowserAutomationTarget(applicationName: "Safari Technology Preview", family: .safari)
        default:
            return nil
        }
    }

    private func runFocusedTextBrowserScript(
        browser: BrowserAutomationTarget,
        attemptID: Int
    ) -> String? {
        let javascript = focusedTextBrowserJavaScript()
        let script: String
        switch browser.family {
        case .chromium:
            script = """
            tell application \(appleScriptStringLiteral(browser.applicationName))
                if (count of windows) is 0 then return ""
                return execute active tab of front window javascript \(appleScriptStringLiteral(javascript))
            end tell
            """
        case .safari:
            script = """
            tell application \(appleScriptStringLiteral(browser.applicationName))
                if (count of windows) is 0 then return ""
                return do JavaScript \(appleScriptStringLiteral(javascript)) in current tab of front window
            end tell
            """
        }

        var error: NSDictionary?
        guard let appleScript = NSAppleScript(source: script) else {
            logCopy(attemptID, "browser JavaScript path failed to create NSAppleScript")
            return nil
        }

        let started = Date()
        let result = appleScript.executeAndReturnError(&error)
        let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)

        if let error {
            let errorNumber = (error[NSAppleScript.errorNumber] as? NSNumber)?.intValue
            let message = (error[NSAppleScript.errorMessage] as? String)
                ?? (error[NSAppleScript.errorBriefMessage] as? String)
                ?? "\(error)"
            if errorNumber == 12,
               message.localizedCaseInsensitiveContains("JavaScript") {
                logCopy(
                    attemptID,
                    "browser JavaScript AppleScript blocked elapsedMs=\(elapsedMs); enable View > Developer > Allow JavaScript from Apple Events in \(browser.applicationName)"
                )
                return nil
            }

            logCopy(attemptID, "browser JavaScript AppleScript error elapsedMs=\(elapsedMs), error=\(error)")
            return nil
        }

        let text = result.stringValue
        logCopy(
            attemptID,
            "browser JavaScript AppleScript completed elapsedMs=\(elapsedMs), resultType=\(result.descriptorType), chars=\(text?.count ?? -1)"
        )
        return text
    }

    private func appleScriptStringLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }

    private func focusedTextBrowserJavaScript() -> String {
        """
        (() => {
          const result = (ok, payload) => JSON.stringify(Object.assign({ ok }, payload));
          const inputTypes = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'number']);
          const tag = (el) => el && el.tagName ? el.tagName.toLowerCase() : '';
          const isEditableHost = (el) => {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
            const name = tag(el);
            if (name === 'textarea') return true;
            if (name === 'input') return inputTypes.has((el.getAttribute('type') || 'text').toLowerCase());
            if (el.isContentEditable) return true;
            const role = (el.getAttribute('role') || '').toLowerCase();
            if (role === 'textbox' || role === 'searchbox') return true;
            return false;
          };
          const normalizeText = (value) => String(value ?? '').replace(/\\r\\n/g, '\\n');
          const closestEditable = (node) => {
            let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            while (el) {
              if (isEditableHost(el)) return el;
              const found = el.closest?.('textarea,input,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"],[role="searchbox"],.cm-content,.CodeMirror,.ace_editor,.monaco-editor');
              if (found) return found;
              el = el.parentElement || el.getRootNode()?.host || null;
            }
            return null;
          };
          const deepActiveElement = () => {
            let active = document.activeElement;
            const seen = new Set();
            while (active && !seen.has(active)) {
              seen.add(active);
              if (active.shadowRoot?.activeElement) {
                active = active.shadowRoot.activeElement;
                continue;
              }
              if (tag(active) === 'iframe') {
                try {
                  if (active.contentDocument?.activeElement) {
                    active = active.contentDocument.activeElement;
                    continue;
                  }
                } catch (_) {
                  return { iframeBlocked: true, element: active };
                }
              }
              break;
            }
            return { iframeBlocked: false, element: active };
          };
          const textFromDomEditor = (el) => {
            const codeMirror5 = el.closest?.('.CodeMirror')?.CodeMirror;
            if (codeMirror5 && typeof codeMirror5.getValue === 'function') {
              return { kind: 'codemirror5', text: codeMirror5.getValue() };
            }
            const ace = el.closest?.('.ace_editor')?.env?.editor;
            if (ace && typeof ace.getValue === 'function') {
              return { kind: 'ace', text: ace.getValue() };
            }
            if (el.closest?.('.monaco-editor') && globalThis.monaco?.editor?.getModels) {
              const models = globalThis.monaco.editor.getModels();
              if (models.length === 1 && typeof models[0].getValue === 'function') {
                return { kind: 'monaco', text: models[0].getValue() };
              }
            }
            if (el.classList?.contains('cm-content') || el.closest?.('.cm-editor')) {
              return { kind: 'codemirror-dom', text: el.closest('.cm-content')?.innerText ?? el.innerText ?? el.textContent ?? '' };
            }
            return null;
          };
          const readElement = (el) => {
            if (!el) return result(false, { reason: 'no-active-element' });
            const name = tag(el);
            if (name === 'input') {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              if (type === 'password') return result(false, { reason: 'password-field', tagName: name });
              if (!inputTypes.has(type)) return result(false, { reason: 'unsupported-input-type', tagName: name, kind: type });
              const text = normalizeText(el.value);
              return result(true, { text, kind: 'input', tagName: name, length: text.length });
            }
            if (name === 'textarea') {
              const text = normalizeText(el.value);
              return result(true, { text, kind: 'textarea', tagName: name, length: text.length });
            }
            const editorText = textFromDomEditor(el);
            if (editorText) {
              const text = normalizeText(editorText.text);
              return result(true, { text, kind: editorText.kind, tagName: name, length: text.length });
            }
            const host = closestEditable(el);
            if (!host) return result(false, { reason: 'active-element-not-editable', tagName: name });
            const hostName = tag(host);
            if (hostName === 'input' || hostName === 'textarea') return readElement(host);
            const hostEditorText = textFromDomEditor(host);
            if (hostEditorText) {
              const text = normalizeText(hostEditorText.text);
              return result(true, { text, kind: hostEditorText.kind, tagName: hostName, length: text.length });
            }
            const text = normalizeText(host.innerText ?? host.textContent ?? '');
            return result(true, { text, kind: host.isContentEditable ? 'contenteditable' : 'role-textbox', tagName: hostName, length: text.length });
          };
          const active = deepActiveElement();
          if (active.iframeBlocked) return result(false, { reason: 'cross-origin-iframe', tagName: tag(active.element) });
          const selection = window.getSelection?.();
          const selectedHost = selection?.anchorNode ? closestEditable(selection.anchorNode) : null;
          return readElement(selectedHost || active.element);
        })()
        """
    }

    private func enableManualAccessibilityForFrontmostApplication(attemptID: Int) {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "AXManualAccessibility skipped because frontmostApplication=nil")
            return
        }

        if app.bundleIdentifier == Bundle.main.bundleIdentifier {
            logCopy(attemptID, "AXManualAccessibility skipped for helper itself")
            return
        }

        guard manualAccessibilityActivationCache.markAttemptedIfNeeded(app.processIdentifier) else {
            logCopy(
                attemptID,
                "AXManualAccessibility already attempted for pid=\(app.processIdentifier), bundle=\(app.bundleIdentifier ?? "nil")"
            )
            return
        }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        let error = AXUIElementSetAttributeValue(
            appElement,
            "AXManualAccessibility" as CFString,
            kCFBooleanTrue
        )
        logCopy(
            attemptID,
            "set AXManualAccessibility=true for frontmost pid=\(app.processIdentifier), bundle=\(app.bundleIdentifier ?? "nil"), error=\(axErrorName(error))"
        )

        if error == .success {
            Thread.sleep(forTimeInterval: 0.03)
        }
    }

    private func rememberKeyboardShortcutFastPathForFrontmostApp(attemptID: Int) {
        guard learnFastKeyboardFallbackEnabled() else {
            logCopy(
                attemptID,
                "fast keyboard-shortcut learning skipped; set FOCUS_COPY_LEARN_FAST_KEYBOARD=1 to enable"
            )
            return
        }

        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleID = app.bundleIdentifier,
              !bundleID.isEmpty else {
            return
        }

        keyboardShortcutFastPathCache.insert(bundleID)
        logCopy(
            attemptID,
            "learned fast keyboard-shortcut path for bundle=\(bundleID), pid=\(app.processIdentifier)"
        )
    }

    static func isAccessibilityTrusted(prompt: Bool) -> Bool {
        let options = [
            "AXTrustedCheckOptionPrompt": prompt
        ] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func focusedElement(attemptID: Int) throws -> AXUIElement {
        let systemWide = AXUIElementCreateSystemWide()
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(
            systemWide,
            kAXFocusedUIElementAttribute as CFString,
            &value
        )
        logCopy(attemptID, "AXFocusedUIElement error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")

        guard error == .success, let element = value else {
            return try focusedElementFromFrontmostApplication(
                fallbackError: error,
                attemptID: attemptID
            )
        }

        return element as! AXUIElement
    }

    private func focusedElementFromFrontmostApplication(
        fallbackError: AXError,
        attemptID: Int
    ) throws -> AXUIElement {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            logCopy(attemptID, "frontmost app fallback skipped because frontmostApplication=nil")
            throw FocusCopyError.focusedElementUnavailable(fallbackError)
        }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var appFocusedValue: CFTypeRef?
        let appFocusedError = AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedUIElementAttribute as CFString,
            &appFocusedValue
        )
        logCopy(
            attemptID,
            "frontmost app AXFocusedUIElement pid=\(app.processIdentifier), bundle=\(app.bundleIdentifier ?? "nil"), error=\(axErrorName(appFocusedError)), valueType=\(cfTypeDescription(appFocusedValue))"
        )

        if appFocusedError == .success,
           let element = appFocusedValue {
            return element as! AXUIElement
        }

        var focusedWindowValue: CFTypeRef?
        let focusedWindowError = AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedWindowAttribute as CFString,
            &focusedWindowValue
        )
        logCopy(
            attemptID,
            "frontmost app AXFocusedWindow error=\(axErrorName(focusedWindowError)), valueType=\(cfTypeDescription(focusedWindowValue))"
        )

        if focusedWindowError == .success,
           let focusedWindowValue,
           CFGetTypeID(focusedWindowValue) == AXUIElementGetTypeID() {
            let windowElement = focusedWindowValue as! AXUIElement
            var windowFocusedValue: CFTypeRef?
            let windowFocusedError = AXUIElementCopyAttributeValue(
                windowElement,
                kAXFocusedUIElementAttribute as CFString,
                &windowFocusedValue
            )
            logCopy(
                attemptID,
                "frontmost focused window AXFocusedUIElement error=\(axErrorName(windowFocusedError)), valueType=\(cfTypeDescription(windowFocusedValue))"
            )

            if windowFocusedError == .success,
               let element = windowFocusedValue {
                return element as! AXUIElement
            }

            if deepAXFocusedDescendantSearchEnabled() {
                if let descendant = findFocusedDescendant(
                    root: windowElement,
                    label: "frontmost focused window",
                    attemptID: attemptID
                ) {
                    return descendant
                }
            }
        }

        if deepAXFocusedDescendantSearchEnabled() {
            if let descendant = findFocusedDescendant(
                root: appElement,
                label: "frontmost app",
                attemptID: attemptID
            ) {
                return descendant
            }
        } else {
            logCopy(
                attemptID,
                "deep AX focused descendant search skipped; set FOCUS_COPY_DEEP_AX_SEARCH=1 to enable"
            )
        }

        throw FocusCopyError.focusedElementUnavailable(fallbackError)
    }

    private func findFocusedDescendant(
        root: AXUIElement,
        label: String,
        attemptID: Int
    ) -> AXUIElement? {
        struct QueueItem {
            let element: AXUIElement
            let depth: Int
        }

        var queue = [QueueItem(element: root, depth: 0)]
        var visited = 0
        let maxVisited = 700
        let maxDepth = 12

        while !queue.isEmpty && visited < maxVisited {
            let item = queue.removeFirst()
            visited += 1

            if elementIsFocused(item.element, attemptID: attemptID),
               elementLooksTextReadable(item.element, attemptID: attemptID) {
                logCopy(
                    attemptID,
                    "\(label) descendant focused text element found depth=\(item.depth), visited=\(visited)"
                )
                logFocusedElement(item.element, attemptID: attemptID)
                return item.element
            }

            guard item.depth < maxDepth else {
                continue
            }

            for child in childElements(of: item.element, attemptID: attemptID) {
                queue.append(QueueItem(element: child, depth: item.depth + 1))
            }
        }

        logCopy(
            attemptID,
            "\(label) descendant focused text search finished without match visited=\(visited), remaining=\(queue.count)"
        )
        return nil
    }

    private func elementIsFocused(_ element: AXUIElement, attemptID: Int) -> Bool {
        let (error, value) = copyAttributeResult(element, kAXFocusedAttribute as CFString)
        guard error == .success,
              let value else {
            return false
        }

        let focused: Bool
        if let boolValue = value as? Bool {
            focused = boolValue
        } else if let number = value as? NSNumber {
            focused = number.boolValue
        } else if CFGetTypeID(value) == CFBooleanGetTypeID() {
            focused = CFBooleanGetValue((value as! CFBoolean))
        } else {
            focused = false
        }

        if focused {
            logCopy(
                attemptID,
                "AXFocused=true element role=\(copyStringAttribute(element, kAXRoleAttribute as CFString)) valueType=\(cfTypeDescription(copyAttributeResult(element, kAXValueAttribute as CFString).1))"
            )
        }

        return focused
    }

    private func elementLooksTextReadable(_ element: AXUIElement, attemptID: Int) -> Bool {
        let role = copyStringAttribute(element, kAXRoleAttribute as CFString)
        let (valueError, value) = copyAttributeResult(element, kAXValueAttribute as CFString)
        let (selectedRangeError, selectedRangeValue) = copyAttributeResult(
            element,
            kAXSelectedTextRangeAttribute as CFString
        )
        let (selectedTextError, selectedTextValue) = copyAttributeResult(
            element,
            kAXSelectedTextAttribute as CFString
        )

        let readable = (valueError == .success && value is String)
            || (selectedRangeError == .success && selectedRangeValue != nil)
            || (selectedTextError == .success && selectedTextValue is String)

        if readable {
            logCopy(
                attemptID,
                "focused element looks text-readable role={\(role)}, AXValue=\(axErrorName(valueError))/\(cfTypeDescription(value)), AXSelectedTextRange=\(axErrorName(selectedRangeError))/\(cfTypeDescription(selectedRangeValue)), AXSelectedText=\(axErrorName(selectedTextError))/\(cfTypeDescription(selectedTextValue))"
            )
        }

        return readable
    }

    private func childElements(of element: AXUIElement, attemptID: Int) -> [AXUIElement] {
        var result: [AXUIElement] = []
        appendChildren(
            from: element,
            attribute: kAXChildrenAttribute as CFString,
            to: &result,
            attemptID: attemptID
        )
        appendChildren(
            from: element,
            attribute: kAXVisibleChildrenAttribute as CFString,
            to: &result,
            attemptID: attemptID
        )
        return result
    }

    private func appendChildren(
        from element: AXUIElement,
        attribute: CFString,
        to result: inout [AXUIElement],
        attemptID: Int
    ) {
        let (error, value) = copyAttributeResult(element, attribute)
        guard error == .success,
              let value else {
            return
        }

        if CFGetTypeID(value) == AXUIElementGetTypeID() {
            result.append(value as! AXUIElement)
            return
        }

        guard CFGetTypeID(value) == CFArrayGetTypeID() else {
            logCopy(
                attemptID,
                "children attribute \(attribute) returned non-array valueType=\(cfTypeDescription(value))"
            )
            return
        }

        let children = value as! [AnyObject]
        for child in children {
            let childRef = child as CFTypeRef
            if CFGetTypeID(childRef) == AXUIElementGetTypeID() {
                result.append(childRef as! AXUIElement)
            }
        }
    }

    private func readAXValueText(from element: AXUIElement, attemptID: Int) -> String? {
        let (error, value) = copyAttributeResult(element, kAXValueAttribute as CFString)
        logCopy(attemptID, "read AXValue error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard let value,
              let text = value as? String else {
            return nil
        }
        return text
    }

    private func readSelectedText(from element: AXUIElement, attemptID: Int) -> String? {
        let (error, value) = copyAttributeResult(element, kAXSelectedTextAttribute as CFString)
        logCopy(attemptID, "read AXSelectedText error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard let value,
              let text = value as? String else {
            return nil
        }
        return text
    }

    private func waitForSelectedText(from element: AXUIElement, expectedMinimumLength: Int, attemptID: Int) -> String? {
        let delays: [TimeInterval] = [0, 0.006, 0.014, 0.03, 0.06]

        for (index, delay) in delays.enumerated() {
            if delay > 0 {
                Thread.sleep(forTimeInterval: delay)
            }

            let text = readSelectedText(from: element, attemptID: attemptID)
            logCopy(attemptID, "wait selected text try=\(index), delay=\(delay), textChars=\(text?.count ?? -1)")
            if let text,
               expectedMinimumLength == 0 || !text.isEmpty {
                return text
            }
        }

        return readSelectedText(from: element, attemptID: attemptID)
    }

    private func selectedTextRange(for element: AXUIElement, attemptID: Int) -> AXTextRange? {
        let (error, value) = copyAttributeResult(element, kAXSelectedTextRangeAttribute as CFString)
        logCopy(attemptID, "read AXSelectedTextRange error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard let value else {
            return nil
        }
        return textRange(from: value)
    }

    private func fullTextRange(for element: AXUIElement, attemptID: Int) -> AXTextRange? {
        let (error, value) = copyAttributeResult(element, kAXNumberOfCharactersAttribute as CFString)
        logCopy(attemptID, "read AXNumberOfCharacters error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard let value else {
            return nil
        }

        if let number = value as? NSNumber {
            return AXTextRange(location: 0, length: max(0, number.intValue))
        }

        if CFGetTypeID(value) == CFNumberGetTypeID() {
            var length = 0
            CFNumberGetValue((value as! CFNumber), .intType, &length)
            return AXTextRange(location: 0, length: max(0, length))
        }

        return nil
    }

    private func readStringForRange(from element: AXUIElement, range: AXTextRange, attemptID: Int) -> String? {
        guard let rangeValue = axValue(from: range) else {
            logCopy(attemptID, "AXStringForRange failed because AXValueCreate returned nil for range=\(describe(range))")
            return nil
        }

        var value: CFTypeRef?
        let error = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXStringForRangeParameterizedAttribute as CFString,
            rangeValue,
            &value
        )
        logCopy(attemptID, "read AXStringForRange range=\(describe(range)), error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")

        guard error == .success, let text = value as? String else {
            return nil
        }

        return text
    }

    private func readAttributedStringForRange(from element: AXUIElement, range: AXTextRange, attemptID: Int) -> String? {
        guard let rangeValue = axValue(from: range) else {
            logCopy(attemptID, "AXAttributedStringForRange failed because AXValueCreate returned nil for range=\(describe(range))")
            return nil
        }

        var value: CFTypeRef?
        let error = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXAttributedStringForRangeParameterizedAttribute as CFString,
            rangeValue,
            &value
        )
        logCopy(attemptID, "read AXAttributedStringForRange range=\(describe(range)), error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")

        guard error == .success,
              let value else {
            return nil
        }

        if let attributed = value as? NSAttributedString {
            return attributed.string
        }

        if CFGetTypeID(value) == CFAttributedStringGetTypeID() {
            return (value as! NSAttributedString).string
        }

        return nil
    }

    private func readTextViaTextMarkers(
        from element: AXUIElement,
        fullRange: AXTextRange?,
        attemptID: Int
    ) -> String? {
        if let range = textMarkerRangeFromStartEndMarkers(element: element, attemptID: attemptID) {
            if let text = readStringForTextMarkerRange(from: element, range: range, attemptID: attemptID) {
                return text
            }
            if let text = readAttributedStringForTextMarkerRange(from: element, range: range, attemptID: attemptID) {
                return text
            }
        }

        guard let fullRange else {
            logCopy(attemptID, "AXTextMarkerForIndex skipped because fullRange=nil")
            return nil
        }

        guard let range = textMarkerRangeForCharacterRange(
            element: element,
            characterRange: fullRange,
            attemptID: attemptID
        ) else {
            return nil
        }

        if let text = readStringForTextMarkerRange(from: element, range: range, attemptID: attemptID) {
            return text
        }
        return readAttributedStringForTextMarkerRange(from: element, range: range, attemptID: attemptID)
    }

    private func textMarkerRangeFromStartEndMarkers(
        element: AXUIElement,
        attemptID: Int
    ) -> AXTextMarkerRange? {
        guard let start = textMarkerAttribute(element, "AXStartTextMarker" as CFString, attemptID: attemptID),
              let end = textMarkerAttribute(element, "AXEndTextMarker" as CFString, attemptID: attemptID) else {
            return nil
        }

        let range = AXTextMarkerRangeCreate(kCFAllocatorDefault, start, end)
        logCopy(attemptID, "AXTextMarkerRangeCreate from AXStartTextMarker/AXEndTextMarker succeeded")
        return range
    }

    private func textMarkerRangeForCharacterRange(
        element: AXUIElement,
        characterRange: AXTextRange,
        attemptID: Int
    ) -> AXTextMarkerRange? {
        let startIndex = characterRange.location
        let endIndex = characterRange.location + characterRange.length
        guard let start = textMarkerForIndex(startIndex, element: element, attemptID: attemptID),
              let end = textMarkerForIndex(endIndex, element: element, attemptID: attemptID) else {
            return nil
        }

        let range = AXTextMarkerRangeCreate(kCFAllocatorDefault, start, end)
        logCopy(attemptID, "AXTextMarkerRangeCreate from AXTextMarkerForIndex succeeded range=\(describe(characterRange))")
        return range
    }

    private func textMarkerAttribute(
        _ element: AXUIElement,
        _ attribute: CFString,
        attemptID: Int
    ) -> AXTextMarker? {
        let (error, value) = copyAttributeResult(element, attribute)
        logCopy(attemptID, "read \(attribute) error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard error == .success,
              let value,
              CFGetTypeID(value) == AXTextMarkerGetTypeID() else {
            return nil
        }
        return (value as! AXTextMarker)
    }

    private func textMarkerForIndex(
        _ index: Int,
        element: AXUIElement,
        attemptID: Int
    ) -> AXTextMarker? {
        var value: CFTypeRef?
        let parameter = NSNumber(value: index) as CFNumber
        let error = AXUIElementCopyParameterizedAttributeValue(
            element,
            "AXTextMarkerForIndex" as CFString,
            parameter,
            &value
        )
        logCopy(attemptID, "read AXTextMarkerForIndex index=\(index), error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard error == .success,
              let value,
              CFGetTypeID(value) == AXTextMarkerGetTypeID() else {
            return nil
        }
        return (value as! AXTextMarker)
    }

    private func readStringForTextMarkerRange(
        from element: AXUIElement,
        range: AXTextMarkerRange,
        attemptID: Int
    ) -> String? {
        var value: CFTypeRef?
        let error = AXUIElementCopyParameterizedAttributeValue(
            element,
            "AXStringForTextMarkerRange" as CFString,
            range,
            &value
        )
        logCopy(attemptID, "read AXStringForTextMarkerRange error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard error == .success,
              let text = value as? String else {
            return nil
        }
        return text
    }

    private func readAttributedStringForTextMarkerRange(
        from element: AXUIElement,
        range: AXTextMarkerRange,
        attemptID: Int
    ) -> String? {
        var value: CFTypeRef?
        let error = AXUIElementCopyParameterizedAttributeValue(
            element,
            "AXAttributedStringForTextMarkerRange" as CFString,
            range,
            &value
        )
        logCopy(attemptID, "read AXAttributedStringForTextMarkerRange error=\(axErrorName(error)), valueType=\(cfTypeDescription(value))")
        guard error == .success,
              let value else {
            return nil
        }

        if let attributed = value as? NSAttributedString {
            return attributed.string
        }

        if CFGetTypeID(value) == CFAttributedStringGetTypeID() {
            return (value as! NSAttributedString).string
        }

        return nil
    }

    private func readTextBySelectingAll(
        element: AXUIElement,
        fullRange: AXTextRange,
        restore originalRange: AXTextRange?,
        attemptID: Int
    ) throws -> String? {
        let restoreRange = originalRange ?? AXTextRange(
            location: fullRange.location + fullRange.length,
            length: 0
        )
        logCopy(attemptID, "select-all strategy begin fullRange=\(describe(fullRange)), restoreRange=\(describe(restoreRange))")

        defer {
            restoreSelection(element: element, range: restoreRange, attemptID: attemptID)
        }

        guard setSelectedTextRange(fullRange, for: element, attemptID: attemptID) else {
            logCopy(attemptID, "select-all strategy failed to set full AXSelectedTextRange")
            return nil
        }
        logCopy(attemptID, "select-all strategy set full AXSelectedTextRange OK")

        return waitForSelectedText(from: element, expectedMinimumLength: fullRange.length, attemptID: attemptID)
    }

    private func copyBySelectingAllAndSendingKeyboardCopy(
        element: AXUIElement,
        fullRange: AXTextRange,
        restore originalRange: AXTextRange?,
        attemptID: Int
    ) throws -> String? {
        let restoreRange = originalRange ?? AXTextRange(
            location: fullRange.location + fullRange.length,
            length: 0
        )
        logCopy(attemptID, "keyboard-copy strategy begin fullRange=\(describe(fullRange)), restoreRange=\(describe(restoreRange))")

        defer {
            restoreSelection(element: element, range: restoreRange, attemptID: attemptID)
        }

        guard setSelectedTextRange(fullRange, for: element, attemptID: attemptID) else {
            logCopy(attemptID, "keyboard-copy strategy failed to set full AXSelectedTextRange")
            return nil
        }
        logCopy(attemptID, "keyboard-copy strategy set full AXSelectedTextRange OK")

        let pasteboard = NSPasteboard.general
        let previousChangeCount = pasteboard.changeCount
        logCopy(attemptID, "keyboard-copy strategy pasteboard previousChangeCount=\(previousChangeCount)")
        sendCommandC()
        logCopy(attemptID, "keyboard-copy strategy posted Cmd+C")

        let deadline = Date().addingTimeInterval(0.12)
        var loopCount = 0
        repeat {
            loopCount += 1
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
            if pasteboard.changeCount != previousChangeCount,
               let text = pasteboard.string(forType: .string) {
                logCopy(attemptID, "keyboard-copy strategy pasteboard changed after loops=\(loopCount), newChangeCount=\(pasteboard.changeCount)")
                return text
            }
        } while Date() < deadline

        logCopy(attemptID, "keyboard-copy strategy timeout loops=\(loopCount), finalChangeCount=\(pasteboard.changeCount)")
        return pasteboard.changeCount != previousChangeCount
            ? pasteboard.string(forType: .string)
            : nil
    }

    private func copyByKeyboardShortcuts(attemptID: Int) throws -> CopyResult? {
        let pasteboard = NSPasteboard.general
        let beforeClearChangeCount = pasteboard.changeCount
        logCopy(
            attemptID,
            "keyboard-shortcut fallback begin beforeClearChangeCount=\(beforeClearChangeCount); original caret cannot be restored without AX focused element"
        )

        pasteboard.clearContents()
        let afterClearChangeCount = pasteboard.changeCount
        logCopy(attemptID, "keyboard-shortcut fallback pasteboard cleared changeCount=\(afterClearChangeCount)")

        sendCommandA()
        logCopy(attemptID, "keyboard-shortcut fallback posted Cmd+A")
        Thread.sleep(forTimeInterval: 0.006)

        sendCommandC()
        logCopy(attemptID, "keyboard-shortcut fallback posted Cmd+C")

        let deadline = Date().addingTimeInterval(0.2)
        var loopCount = 0
        var copiedText: String?
        repeat {
            loopCount += 1
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
            if pasteboard.changeCount != afterClearChangeCount {
                copiedText = pasteboard.string(forType: .string)
                break
            }
        } while Date() < deadline

        sendRightArrow()
        logCopy(attemptID, "keyboard-shortcut fallback posted RightArrow to collapse selection")

        guard let copiedText else {
            logCopy(
                attemptID,
                "keyboard-shortcut fallback failed: pasteboard did not change after loops=\(loopCount), finalChangeCount=\(pasteboard.changeCount)"
            )
            return nil
        }

        logCopy(
            attemptID,
            "keyboard-shortcut fallback pasteboard changed after loops=\(loopCount), newChangeCount=\(pasteboard.changeCount), \(textDebugSummary(copiedText))"
        )
        return CopyResult(method: .keyboardShortcut, text: copiedText)
    }

    private func restoreSelection(element: AXUIElement, range: AXTextRange?, attemptID: Int) {
        guard let range else {
            logCopy(attemptID, "restoreSelection skipped because range=nil")
            return
        }
        logCopy(attemptID, "restoreSelection begin range=\(describe(range))")
        if !setSelectedTextRange(range, for: element, attemptID: attemptID) {
            logCopy(attemptID, "restoreSelection failed range=\(describe(range))")
        } else {
            logCopy(attemptID, "restoreSelection succeeded range=\(describe(range))")
        }
    }

    private func setSelectedTextRange(_ range: AXTextRange, for element: AXUIElement, attemptID: Int) -> Bool {
        guard let value = axValue(from: range) else {
            logCopy(attemptID, "set AXSelectedTextRange failed because AXValueCreate returned nil range=\(describe(range))")
            return false
        }

        let error = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            value
        )
        logCopy(attemptID, "set AXSelectedTextRange range=\(describe(range)), error=\(axErrorName(error))")
        return error == .success
    }

    private func isSelectedTextRangeSettable(for element: AXUIElement, attemptID: Int) -> Bool {
        var settable = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &settable
        )
        logCopy(attemptID, "AXUIElementIsAttributeSettable(AXSelectedTextRange) error=\(axErrorName(error)), settable=\(settable.boolValue)")
        return error == .success && settable.boolValue
    }

    private func textRange(from value: CFTypeRef) -> AXTextRange? {
        guard CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }

        var range = CFRange()
        guard AXValueGetValue((value as! AXValue), .cfRange, &range) else {
            return nil
        }

        return AXTextRange(location: range.location, length: range.length)
    }

    private func axValue(from range: AXTextRange) -> AXValue? {
        var cfRange = range.cfRange
        return AXValueCreate(.cfRange, &cfRange)
    }

    private func copyAttributeResult(_ element: AXUIElement, _ attribute: CFString) -> (AXError, CFTypeRef?) {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute, &value)
        return (error, value)
    }

    private func copyStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String {
        let (error, value) = copyAttributeResult(element, attribute)
        guard error == .success else {
            return "\(attribute)=<\(axErrorName(error))>"
        }
        if let value = value as? String {
            return "\(attribute)=\(value)"
        }
        return "\(attribute)=<\(cfTypeDescription(value))>"
    }

    private func logFocusedElement(_ element: AXUIElement, attemptID: Int) {
        var pid: pid_t = 0
        let pidError = AXUIElementGetPid(element, &pid)
        let app = pidError == .success ? NSRunningApplication(processIdentifier: pid) : nil
        let appSummary = [
            "pid=\(pidError == .success ? String(pid) : "<\(axErrorName(pidError))>")",
            "bundle=\(app?.bundleIdentifier ?? "nil")",
            "name=\(app?.localizedName ?? "nil")"
        ].joined(separator: ", ")

        let attrs = [
            copyStringAttribute(element, kAXRoleAttribute as CFString),
            copyStringAttribute(element, kAXSubroleAttribute as CFString),
            copyStringAttribute(element, kAXTitleAttribute as CFString),
            copyStringAttribute(element, kAXDescriptionAttribute as CFString),
            copyStringAttribute(element, kAXIdentifierAttribute as CFString)
        ].joined(separator: ", ")

        logCopy(attemptID, "focused element app={\(appSummary)} attrs={\(attrs)}")
    }

    private func writePasteboard(_ text: String, attemptID: Int) throws {
        let pasteboard = NSPasteboard.general
        let beforeChangeCount = pasteboard.changeCount
        logCopy(attemptID, "pasteboard write begin beforeChangeCount=\(beforeChangeCount), \(textDebugSummary(text))")
        pasteboard.clearContents()
        logCopy(attemptID, "pasteboard after clear changeCount=\(pasteboard.changeCount)")

        if text.isEmpty {
            guard pasteboard.changeCount >= 0 else {
                throw FocusCopyError.emptyPasteboardWriteFailed
            }
            logCopy(attemptID, "pasteboard write skipped setString because text is empty")
            return
        }

        let setOK = pasteboard.setString(text, forType: .string)
        logCopy(attemptID, "pasteboard setString result=\(setOK), afterChangeCount=\(pasteboard.changeCount)")
        guard setOK else {
            throw FocusCopyError.pasteboardWriteFailed
        }
    }

    private func sendCommandC() {
        sendCommandKey(CGKeyCode(kVK_ANSI_C))
    }

    private func sendCommandA() {
        sendCommandKey(CGKeyCode(kVK_ANSI_A))
    }

    private func sendCommandKey(_ keyCode: CGKeyCode) {
        let source = CGEventSource(stateID: .hidSystemState)

        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        keyDown?.flags = .maskCommand

        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        keyUp?.flags = .maskCommand

        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
    }

    private func sendRightArrow() {
        let source = CGEventSource(stateID: .hidSystemState)
        let keyCode = CGKeyCode(kVK_RightArrow)

        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)

        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
    }
}

private final class HotkeyRunner: @unchecked Sendable {
    private enum HotkeyAction: UInt32 {
        case copyAll = 1
        case copyEditorApi = 2

        var label: String {
            switch self {
            case .copyAll:
                return "Ctrl+Shift+A"
            case .copyEditorApi:
                return "Ctrl+Shift+S"
            }
        }
    }

    private let copier = FocusTextCopier()
    private var copyAllHotKeyRef: EventHotKeyRef?
    private var editorApiHotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private var isHandlingHotkey = false
    private var lastHotkeyCompletedAt = Date.distantPast

    func run() throws -> Never {
        let trusted = FocusTextCopier.isAccessibilityTrusted(prompt: false)
        log("initial accessibility trusted=\(trusted)")

        try registerHotkey()

        log("Running. Press Ctrl+Shift+A for universal copy or Ctrl+Shift+S for focused editor API copy.")
        log("Entering Carbon application event loop for RegisterEventHotKey delivery")
        carbonRunApplicationEventLoop()
        exit(0)
    }

    func copyOnce() throws {
        log("copyOnce invoked")
        let result = try copier.copyFocusedTextToPasteboard()
        log("Copied \(result.characterCount) chars via \(result.method.rawValue).")
    }

    private func registerHotkey() throws {
        let modifiers = UInt32(controlKey | shiftKey)
        let selfPointer = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

        try registerSingleHotkey(
            action: .copyAll,
            keyCode: UInt32(kVK_ANSI_A),
            modifiers: modifiers,
            hotKeyRef: &copyAllHotKeyRef
        )
        try registerSingleHotkey(
            action: .copyEditorApi,
            keyCode: UInt32(kVK_ANSI_S),
            modifiers: modifiers,
            hotKeyRef: &editorApiHotKeyRef
        )

        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        let handlerStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            hotkeyHandler,
            1,
            &eventSpec,
            selfPointer,
            &eventHandlerRef
        )
        log("registerHotkey InstallEventHandler status=\(handlerStatus), eventHandlerRefIsNil=\(eventHandlerRef == nil)")

        guard handlerStatus == noErr else {
            throw FocusCopyError.hotkeyHandlerInstallationFailed(handlerStatus)
        }
        log("registerHotkey success")
    }

    private func registerSingleHotkey(
        action: HotkeyAction,
        keyCode: UInt32,
        modifiers: UInt32,
        hotKeyRef: inout EventHotKeyRef?
    ) throws {
        let hotKeyID = EventHotKeyID(signature: fourCharCode("HICA"), id: action.rawValue)
        log("registerHotkey begin key=\(action.label) keyCode=\(keyCode), modifiers=\(modifiers), signature=HICA, id=\(action.rawValue)")
        let registerStatus = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        log("registerHotkey RegisterEventHotKey key=\(action.label), status=\(registerStatus), hotKeyRefIsNil=\(hotKeyRef == nil)")

        guard registerStatus == noErr else {
            throw FocusCopyError.hotkeyRegistrationFailed(registerStatus)
        }
    }

    fileprivate func handleHotkey(id: UInt32) {
        let action = HotkeyAction(rawValue: id) ?? .copyAll
        if isHandlingHotkey {
            log("hotkey \(action.label) ignored because copy is already in progress")
            return
        }

        let now = Date()
        let completedDelta = now.timeIntervalSince(lastHotkeyCompletedAt)
        if completedDelta < 0.45 {
            log("hotkey \(action.label) ignored because previous copy completed \(String(format: "%.3f", completedDelta))s ago")
            return
        }

        isHandlingHotkey = true
        let startedAt = Date()
        defer {
            isHandlingHotkey = false
            lastHotkeyCompletedAt = Date()
        }

        log("hotkey handler fired key=\(action.label) on mainThread=\(Thread.isMainThread)")
        do {
            let result: CopyResult
            switch action {
            case .copyAll:
                result = try copier.copyFocusedTextToPasteboard()
            case .copyEditorApi:
                result = try copier.copyFocusedEditorApiTextToPasteboard()
            }
            log("Copied \(result.characterCount) chars via \(result.method.rawValue).")
            emitFocusCopyResult(result: result, error: nil, startedAt: startedAt)
        } catch {
            log("Copy failed: \(error)")
            emitFocusCopyResult(result: nil, error: error, startedAt: startedAt)
        }
    }

}

private func emitFocusCopyResult(result: CopyResult?, error: Error?, startedAt: Date) {
    let app = NSWorkspace.shared.frontmostApplication
    let event = FocusCopyResultEvent(
        type: "focusCopyResult",
        ok: result != nil,
        text: result?.text,
        method: result?.method.rawValue,
        characterCount: result?.characterCount ?? 0,
        appName: app?.localizedName,
        bundleId: app?.bundleIdentifier,
        url: result?.sourceURL,
        error: error.map { "\($0)" },
        elapsedMs: Int(Date().timeIntervalSince(startedAt) * 1000)
    )

    guard let data = try? JSONEncoder().encode(event),
          let line = String(data: data, encoding: .utf8) else {
        log("focus copy result event encode failed")
        return
    }
    print(line)
    fflush(stdout)
}

nonisolated(unsafe) private let hotkeyHandler: EventHandlerUPP = { _, event, userData in
    guard let userData else {
        log("hotkey callback fired without userData")
        return noErr
    }

    var hotKeyID = EventHotKeyID()
    var id: UInt32 = 1
    if let event {
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        if status == noErr {
            id = hotKeyID.id
        } else {
            log("hotkey callback failed to read hotkey id status=\(status); defaulting to Ctrl+Shift+A")
        }
    }

    log("hotkey callback received id=\(id), dispatching copy work")
    let runner = Unmanaged<HotkeyRunner>.fromOpaque(userData).takeUnretainedValue()
    runner.handleHotkey(id: id)

    return noErr
}

private func fourCharCode(_ string: String) -> OSType {
    precondition(string.utf8.count == 4)
    return string.utf8.reduce(0) { result, byte in
        (result << 8) + OSType(byte)
    }
}

private func frontmostApplicationSummary() -> String {
    let app = NSWorkspace.shared.frontmostApplication
    return [
        "pid=\(app?.processIdentifier.description ?? "nil")",
        "bundle=\(app?.bundleIdentifier ?? "nil")",
        "name=\(app?.localizedName ?? "nil")"
    ].joined(separator: ", ")
}

private func applicationSupportDirectoryURL() -> URL {
    let supportDir = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
    ).first?.appendingPathComponent("HackInterview", isDirectory: true)

    return supportDir ?? URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("HackInterview", isDirectory: true)
}

private func currentTimeMillis() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded())
}

private func browserFocusCacheURL() -> URL {
    applicationSupportDirectoryURL()
        .appendingPathComponent("BrowserFocusCopyCache.json")
}

private func browserCdpRequestsDirectoryURL() -> URL {
    applicationSupportDirectoryURL()
        .appendingPathComponent("BrowserFocusCopyRequests", isDirectory: true)
}

private func browserCdpResponsesDirectoryURL() -> URL {
    applicationSupportDirectoryURL()
        .appendingPathComponent("BrowserFocusCopyResponses", isDirectory: true)
}

private func browserCdpHostPresenceDirectoryURL() -> URL {
    applicationSupportDirectoryURL()
        .appendingPathComponent("BrowserFocusCopyHosts", isDirectory: true)
}

private func browserCdpRequestURL(requestId: String) -> URL {
    browserCdpRequestsDirectoryURL()
        .appendingPathComponent("request-\(requestId).json")
}

private func browserCdpResponseURL(requestId: String) -> URL {
    browserCdpResponsesDirectoryURL()
        .appendingPathComponent("response-\(requestId).json")
}

private func browserCdpHostPresenceURL(bundleId: String) -> URL {
    let safeBundleId = bundleId
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: ":", with: "_")
    return browserCdpHostPresenceDirectoryURL()
        .appendingPathComponent("\(safeBundleId).json")
}

private func isBrowserCdpHostPresent(targetBundleId: String?, maxAgeSeconds: TimeInterval) -> Bool {
    guard let targetBundleId,
          !targetBundleId.isEmpty else {
        return false
    }

    let url = browserCdpHostPresenceURL(bundleId: targetBundleId)
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let modifiedAt = attributes[.modificationDate] as? Date else {
        return false
    }
    return Date().timeIntervalSince(modifiedAt) <= maxAgeSeconds
}

private func logStartupEnvironment() {
    let process = ProcessInfo.processInfo
    let bundle = Bundle.main
    log("----- startup -----")
    log("processName=\(process.processName), pid=\(process.processIdentifier)")
    log("executable=\(CommandLine.arguments.first ?? "nil")")
    log("arguments=\(CommandLine.arguments)")
    log("bundlePath=\(bundle.bundlePath)")
    log("bundleIdentifier=\(bundle.bundleIdentifier ?? "nil")")
    log("bundleName=\(bundle.object(forInfoDictionaryKey: "CFBundleName") ?? "nil")")
    log("frontmostAtStartup=\(frontmostApplicationSummary())")
    log("logFile=\(logFileURL().path)")
}

private func logFileURL() -> URL {
    let logsDir = FileManager.default.urls(
        for: .libraryDirectory,
        in: .userDomainMask
    ).first?.appendingPathComponent("Logs/HackInterview", isDirectory: true)

    return (logsDir ?? URL(fileURLWithPath: "/tmp"))
        .appendingPathComponent("MacOSFocusCopyHelper.log")
}

private func log(_ message: String) {
    let formatter = ISO8601DateFormatter()
    let line = "[\(formatter.string(from: Date()))] \(message)"

    if !CommandLine.arguments.contains("--browser-cache-native-host") {
        print(line)
        fflush(stdout)
    }

    do {
        let logFile = logFileURL()
        let logsDir = logFile.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        let data = Data((line + "\n").utf8)

        if FileManager.default.fileExists(atPath: logFile.path) {
            let handle = try FileHandle(forWritingTo: logFile)
            defer {
                try? handle.close()
            }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } else {
            try data.write(to: logFile, options: .atomic)
        }
    } catch {
        // Logging must never break the hotkey path.
    }
}

private func runBrowserCacheNativeHost() -> Never {
    if let targetBundleId = nativeHostTargetBundleId() {
        try? FileManager.default.removeItem(at: browserCdpHostPresenceURL(bundleId: targetBundleId))
    }
    log("browser cache native messaging host started targetBundleId=\(nativeHostTargetBundleId() ?? "nil")")
    startBrowserCdpRequestPump()

    while let data = readNativeMessagingData() {
        do {
            let message = try JSONDecoder().decode(BrowserFocusCacheNativeMessage.self, from: data)
            try handleBrowserCacheNativeMessage(message)
            writeNativeMessagingResponse(["ok": true])
        } catch {
            log("browser cache native messaging host message failed: \(error)")
            writeNativeMessagingResponse(["ok": false, "error": "\(error)"])
        }
    }

    log("browser cache native messaging host stdin closed")
    exit(0)
}

private func handleBrowserCacheNativeMessage(_ message: BrowserFocusCacheNativeMessage) throws {
    if message.type == "focus-copy-extension-ready" {
        if message.supportsCdp == true {
            browserCdpCapabilityState.markReady()
            log("browser cache native messaging host marked CDP ready")
        }
        return
    }

    if message.type == "focus-copy-cdp-response" || message.type == "focus-copy-editor-api-response" {
        try writeBrowserCdpResponse(message)
        return
    }

    guard message.type == "focus-copy-cache-update" else {
        log("browser cache native messaging host ignored type=\(message.type)")
        return
    }

    let payload = BrowserFocusCachePayload(
        schemaVersion: 1,
        source: message.source ?? "browser-extension",
        url: message.url,
        title: message.title,
        frameUrl: message.frameUrl,
        text: message.text,
        kind: message.kind,
        tagName: message.tagName,
        isPassword: message.isPassword ?? false,
        selectionStart: message.selectionStart,
        selectionEnd: message.selectionEnd,
        textLength: message.textLength,
        pageTimestampMs: message.timestampMs,
        receivedAt: Date().timeIntervalSince1970
    )

    let cacheURL = browserFocusCacheURL()
    let cacheDir = cacheURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(payload)
    try data.write(to: cacheURL, options: .atomic)
    log(
        "browser cache updated source=\(payload.source), kind=\(payload.kind ?? "nil"), tag=\(payload.tagName ?? "nil"), isPassword=\(payload.isPassword), chars=\(payload.text?.count ?? -1), url=\(payload.url ?? "nil")"
    )
}

private func nativeHostTargetBundleId() -> String? {
    if let parentApp = NSRunningApplication(processIdentifier: getppid()),
       let parentBundleId = parentApp.bundleIdentifier,
       !parentBundleId.isEmpty {
        return parentBundleId
    }

    let value = ProcessInfo.processInfo.environment["FOCUS_COPY_BROWSER_BUNDLE_ID"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let value,
          !value.isEmpty else {
        return nil
    }
    return value
}

private func startBrowserCdpRequestPump() {
    Thread.detachNewThread {
        let hostBundleId = nativeHostTargetBundleId()
        var sentRequestIds = Set<String>()
        var lastPresenceWrite = Date.distantPast
        while true {
            autoreleasepool {
                if browserCdpCapabilityState.isReady(),
                   let hostBundleId,
                   Date().timeIntervalSince(lastPresenceWrite) >= 0.5 {
                    writeBrowserCdpHostPresence(hostBundleId: hostBundleId)
                    lastPresenceWrite = Date()
                }
                if browserCdpCapabilityState.isReady() {
                    pumpBrowserCdpRequests(hostBundleId: hostBundleId, sentRequestIds: &sentRequestIds)
                }
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
    }
}

private func writeBrowserCdpHostPresence(hostBundleId: String) {
    let url = browserCdpHostPresenceURL(bundleId: hostBundleId)
    do {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "bundleId": hostBundleId,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "updatedAtMs": currentTimeMillis(),
        ])
        try data.write(to: url, options: .atomic)
    } catch {
        log("browser CDP host presence write failed bundleId=\(hostBundleId), error=\(error)")
    }
}

private func pumpBrowserCdpRequests(hostBundleId: String?, sentRequestIds: inout Set<String>) {
    let directory = browserCdpRequestsDirectoryURL()
    guard let files = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: nil
    ) else {
        return
    }

    for file in files where file.lastPathComponent.hasPrefix("request-") && file.pathExtension == "json" {
        guard let data = try? Data(contentsOf: file),
              let request = try? JSONDecoder().decode(BrowserCdpCopyRequest.self, from: data),
              request.type == "focus-copy-cdp-request" || request.type == "focus-copy-editor-api-request" else {
            try? FileManager.default.removeItem(at: file)
            continue
        }

        if let hostBundleId,
           let targetBundleId = request.targetBundleId,
           hostBundleId != targetBundleId {
            continue
        }

        guard !sentRequestIds.contains(request.requestId) else {
            try? FileManager.default.removeItem(at: file)
            continue
        }
        sentRequestIds.insert(request.requestId)
        try? FileManager.default.removeItem(at: file)

        log("browser request pump forwarding type=\(request.type), requestId=\(request.requestId), targetBundleId=\(request.targetBundleId ?? "nil"), hostBundleId=\(hostBundleId ?? "nil")")
        writeNativeMessagingResponse([
            "type": request.type,
            "requestId": request.requestId,
            "deadlineMs": request.deadlineMs,
            "targetBundleId": request.targetBundleId ?? NSNull(),
        ])
    }

    if sentRequestIds.count > 64 {
        sentRequestIds.removeAll(keepingCapacity: true)
    }
}

private func writeBrowserCdpResponse(_ message: BrowserFocusCacheNativeMessage) throws {
    guard let requestId = message.requestId,
          !requestId.isEmpty else {
        log("browser CDP response ignored because requestId is missing")
        return
    }

    let response = BrowserCdpCopyResponse(
        schemaVersion: 1,
        type: message.type,
        requestId: requestId,
        ok: message.ok ?? false,
        method: message.method,
        restored: message.restored,
        error: message.error,
        url: message.url,
        title: message.title,
        frameUrl: message.frameUrl,
        text: message.text,
        kind: message.kind,
        tagName: message.tagName,
        textLength: message.textLength,
        elapsedMs: message.elapsedMs,
        receivedAtMs: currentTimeMillis()
    )

    let responseURL = browserCdpResponseURL(requestId: requestId)
    try FileManager.default.createDirectory(
        at: responseURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    let data = try JSONEncoder().encode(response)
    try data.write(to: responseURL, options: .atomic)
    log("browser CDP response stored requestId=\(requestId), ok=\(response.ok), method=\(response.method ?? "nil"), restored=\(response.restored.map(String.init) ?? "nil")")
}

private func readNativeMessagingData() -> Data? {
    let input = FileHandle.standardInput
    let header = input.readData(ofLength: 4)
    guard header.count == 4 else {
        return nil
    }

    let bytes = [UInt8](header)
    let length = UInt32(bytes[0])
        | (UInt32(bytes[1]) << 8)
        | (UInt32(bytes[2]) << 16)
        | (UInt32(bytes[3]) << 24)

    guard length > 0,
          length <= 64 * 1024 * 1024 else {
        log("browser cache native messaging host invalid message length=\(length)")
        return nil
    }

    let data = input.readData(ofLength: Int(length))
    guard data.count == Int(length) else {
        log("browser cache native messaging host truncated message expected=\(length), actual=\(data.count)")
        return nil
    }

    return data
}

private let nativeMessagingWriteLock = NSLock()

private func writeNativeMessagingResponse(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          data.count <= 1024 * 1024 else {
        return
    }

    var length = UInt32(data.count).littleEndian
    var output = Data(bytes: &length, count: 4)
    output.append(data)
    nativeMessagingWriteLock.lock()
    defer {
        nativeMessagingWriteLock.unlock()
    }
    FileHandle.standardOutput.write(output)
}

private let runner = HotkeyRunner()
private nonisolated(unsafe) var parentWatchdog: DispatchSourceTimer?

private func watchParentProcess() {
    let parentPID = getppid()
    guard parentPID > 1 else { return }
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler {
        if getppid() != parentPID {
            log("Parent process \(parentPID) exited; stopping helper")
            exit(0)
        }
    }
    timer.resume()
    parentWatchdog = timer
}

do {
    if CommandLine.arguments.contains("--browser-cache-native-host") {
        runBrowserCacheNativeHost()
    }

    logStartupEnvironment()

    if CommandLine.arguments.contains("--check-accessibility") {
        let trustedNoPrompt = FocusTextCopier.isAccessibilityTrusted(prompt: false)
        log("check-accessibility trusted(prompt:false)=\(trustedNoPrompt)")
        print("helperBundlePath=\(Bundle.main.bundlePath)")
        print("helperBundleIdentifier=\(Bundle.main.bundleIdentifier ?? "nil")")
        print("helperExecutable=\(CommandLine.arguments.first ?? "nil")")
        print("accessibilityTrustedNoPrompt=\(trustedNoPrompt)")
        exit(trustedNoPrompt ? 0 : 2)
    }

    if CommandLine.arguments.contains("--once") {
        try runner.copyOnce()
        exit(0)
    }

    watchParentProcess()
    try runner.run()
} catch {
    log("Fatal: \(error)")
    exit(1)
}
