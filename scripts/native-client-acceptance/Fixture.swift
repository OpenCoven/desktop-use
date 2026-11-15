import AppKit

// Disposable fixture only. No clipboard, network, private documents or global hooks.
final class FixtureView: NSView, NSTextFieldDelegate {
    var clicks = 0
    var keyEvents = 0
    var scrollOffset = 0
    let status = NSTextField(labelWithString: "")
    let field = NSTextField(string: "")
    let scroll = NSScrollView()
    let landmarks: [(name: String, rect: NSRect, rgb: [CGFloat], label: NSPoint)] = [
        ("NW", NSRect(x: 4, y: 4, width: 16, height: 16), [40, 210, 220], NSPoint(x: 24, y: 1)),
        ("NE", NSRect(x: 620, y: 4, width: 16, height: 16), [200, 60, 210], NSPoint(x: 592, y: 1)),
        ("SW", NSRect(x: 4, y: 448, width: 16, height: 16), [250, 145, 30], NSPoint(x: 24, y: 445)),
        ("SE", NSRect(x: 620, y: 448, width: 16, height: 16), [225, 235, 250], NSPoint(x: 592, y: 445)),
    ]
    let stateURL: URL
    let controlTimeline: FixtureControlTimeline?
    private lazy var stateWriter = FixtureStateWriter(schedule: { callback in
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { callback() }
    }, write: { [weak self] in self?.writeState() })
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(stateURL: URL, observeControls: Bool = false) {
        self.stateURL = stateURL
        self.controlTimeline = observeControls ? FixtureControlTimeline() : nil
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
            self.recordControl(.scroll)
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
        for marker in landmarks {
            NSColor(srgbRed: marker.rgb[0]/255, green: marker.rgb[1]/255, blue: marker.rgb[2]/255, alpha: 1).setFill()
            marker.rect.fill()
            (marker.name as NSString).draw(at: marker.label, withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold), .foregroundColor: NSColor.white])
        }

    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if NSRect(x: 40, y: 40, width: 120, height: 80).contains(point) {
            clicks += 1
            needsDisplay = true
        }
        window?.makeFirstResponder(self)
        recordControl(.click)
        persist()
    }
    override func keyDown(with event: NSEvent) {
        keyEvents += 1
        recordControl(.key)
        persist()
    }
    func controlTextDidChange(_ notification: Notification) {
        recordControl(.text)
        persist()
    }
    private func recordControl(_ kind: FixtureControlTimeline.Kind) {
        controlTimeline?.record(kind, textUtf16Length: field.stringValue.utf16.count, scrollOffset: scrollOffset, keyCount: keyEvents, clickCount: clicks)
    }
    func persist() {
        if controlTimeline != nil {
            status.stringValue = "Clicks: \(clicks) | Keys: \(keyEvents)\nInput length: \(field.stringValue.utf16.count) | Scroll: \(scrollOffset)"
        } else {
            status.stringValue = "Clicks: \(clicks) | Keys: \(keyEvents)\nInput: \(field.stringValue) | Scroll: \(scrollOffset)"
        }
        if controlTimeline != nil { stateWriter.request() } else { writeState() }
    }
    func flushPendingState() {
        if controlTimeline != nil { stateWriter.flushPending() }
    }
    private func writeState() {
        var state: [String: Any] = ["ready": true, "pid": ProcessInfo.processInfo.processIdentifier, "clicks": clicks, "keys": keyEvents, "text": field.stringValue, "scrollOffset": scrollOffset, "fixtureSize": [640, 480], "targetRect": [40, 40, 120, 80], "windowNumber": window?.windowNumber ?? 0]
        if let timeline = controlTimeline,
           let encoded = try? JSONEncoder().encode(timeline.snapshot()),
           let observation = try? JSONSerialization.jsonObject(with: encoded) {
            state["controlObservationV1"] = observation
        }
        state["landmarks"] = landmarks.map { marker in
            ["name": marker.name, "rect": [marker.rect.minX, marker.rect.minY, marker.rect.width, marker.rect.height], "rgb": marker.rgb] as [String: Any]
        }
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
        view = FixtureView(stateURL: stateURL, observeControls: config["observeControls"] == "true")
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(view)
        view.persist()
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.view.persist() }
    }
    func applicationWillTerminate(_ notification: Notification) { view?.flushPendingState() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
enum FixtureApplication {
    static func main() {
        let app = NSApplication.shared
        let delegate = FixtureDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
