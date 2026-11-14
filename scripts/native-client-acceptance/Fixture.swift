import AppKit

// Disposable fixture only. No clipboard, network, private documents or global hooks.
final class FixtureView: NSView, NSTextFieldDelegate {
    var clicks = 0
    var keyEvents = 0
    var scrollOffset = 0
    let status = NSTextField(labelWithString: "")
    let field = NSTextField(string: "")
    let scroll = NSScrollView()
    let stateURL: URL
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(stateURL: URL) {
        self.stateURL = stateURL
        super.init(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        status.frame = NSRect(x: 190, y: 45, width: 420, height: 70)
        status.textColor = .white
        status.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        status.setAccessibilityIdentifier("fixture-status")
        addSubview(status)
        field.frame = NSRect(x: 40, y: 160, width: 540, height: 30)
        field.placeholderString = "Disposable acceptance input"
        field.setAccessibilityIdentifier("fixture-input")
        field.delegate = self
        addSubview(field)
        scroll.frame = NSRect(x: 40, y: 240, width: 540, height: 180)
        scroll.hasVerticalScroller = true
        let document = NSTextView(frame: NSRect(x: 0, y: 0, width: 510, height: 1400))
        document.isEditable = false
        document.string = (1...60).map { "Fixture scroll landmark \($0)" }.joined(separator: "\n")
        document.font = .monospacedSystemFont(ofSize: 18, weight: .regular)
        scroll.documentView = document
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.scrollOffset = Int(self.scroll.contentView.bounds.origin.y)
            self.persist()
        }
        addSubview(scroll)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 20/255, green: 40/255, blue: 80/255, alpha: 1).setFill()
        bounds.fill()
        let target = clicks == 0 ? NSColor(srgbRed: 224/255, green: 48/255, blue: 64/255, alpha: 1) : NSColor(srgbRed: 32/255, green: 192/255, blue: 96/255, alpha: 1)
        target.setFill()
        NSRect(x: 40, y: 40, width: 120, height: 80).fill()
        NSColor(srgbRed: 240/255, green: 210/255, blue: 40/255, alpha: 1).setFill()
        NSRect(x: 40, y: 130, width: 120, height: 20).fill()
    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if NSRect(x: 40, y: 40, width: 120, height: 80).contains(point) {
            clicks += 1
            needsDisplay = true
        }
        window?.makeFirstResponder(self)
        persist()
    }
    override func keyDown(with event: NSEvent) {
        keyEvents += 1
        persist()
    }
    func controlTextDidChange(_ notification: Notification) { persist() }
    func persist() {
        status.stringValue = "Clicks: \(clicks) | Keys: \(keyEvents)\nInput: \(field.stringValue) | Scroll: \(scrollOffset)"
        var state: [String: Any] = ["ready": true, "pid": ProcessInfo.processInfo.processIdentifier, "clicks": clicks, "keys": keyEvents, "text": field.stringValue, "scrollOffset": scrollOffset, "fixtureSize": [640, 480], "targetRect": [40, 40, 120, 80], "windowNumber": window?.windowNumber ?? 0]
        if let window, let screen = NSScreen.screens.first {
            let frame = window.convertToScreen(bounds)
            state["desktopRect"] = ["x": frame.minX, "y": screen.frame.maxY-frame.maxY, "width": frame.width, "height": frame.height]
            let windowFrame = window.frame
            state["windowFrameRect"] = ["x": windowFrame.minX, "y": screen.frame.maxY-windowFrame.maxY, "width": windowFrame.width, "height": windowFrame.height]
            state["backingScale"] = window.backingScaleFactor
            state["focused"] = window.isKeyWindow
        }
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
            try? data.write(to: stateURL, options: [.atomic])
        }
    }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var view: FixtureView!
    func applicationDidFinishLaunching(_ notification: Notification) {
        let configURL = Bundle.main.resourceURL!.appendingPathComponent("runtime.json")
        let config = try! JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: String]
        let stateURL = URL(fileURLWithPath: config["statePath"]!)
        let previous = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let previousURL = stateURL.deletingLastPathComponent().appendingPathComponent("previous-app.json")
        if let previous, let data = try? JSONSerialization.data(withJSONObject: ["bundleId": previous]) { try? data.write(to: previousURL) }
        window = NSWindow(contentRect: NSRect(x: 120, y: 180, width: 640, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Desktop Use Disposable Acceptance"
        window.isReleasedWhenClosed = false
        view = FixtureView(stateURL: stateURL)
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(view)
        view.persist()
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.view.persist() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = FixtureDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
