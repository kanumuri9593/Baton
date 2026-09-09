// Baton HUD — a menu-bar extra and a floating panel over the local daemon.
//
// The compact launcher floats across desktops; the expanded inspector uses
// normal window ordering so switching apps brings their windows to the front.
//
// It is a regular app (Dock + Cmd-Tab) that still hosts the same HTML the
// daemon serves to a browser: one control surface, two ways to open it.

import AppKit
import Carbon.HIToolbox
import Darwin
import ServiceManagement
import WebKit

struct Handshake: Decodable {
    let port: Int
    let token: String
    let pid: Int
}

struct DaemonLauncher: Decodable {
    let node: String
    let entry: String
    let arguments: [String]
    let log: String
}

/// One compact surface does both jobs: a stationary click opens Baton, while a
/// mouse movement drags it. Keeping this native avoids WebKit stealing the drag
/// and lets the visible UI be only the logo.
final class CompactChipSurface: NSView {
    weak var webView: WKWebView?
    private var mouseStart: NSPoint?
    private var windowStart: NSPoint?
    private var dragged = false

    override func mouseDown(with event: NSEvent) {
        mouseStart = NSEvent.mouseLocation
        windowStart = window?.frame.origin
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let mouseStart, let windowStart else { return }
        let current = NSEvent.mouseLocation
        let dx = current.x - mouseStart.x
        let dy = current.y - mouseStart.y
        if hypot(dx, dy) >= 3 { dragged = true }
        guard dragged else { return }
        window.setFrameOrigin(NSPoint(x: windowStart.x + dx, y: windowStart.y + dy))
    }

    override func mouseUp(with event: NSEvent) {
        if !dragged {
            webView?.evaluateJavaScript("document.getElementById('chipFace')?.click()")
        }
        mouseStart = nil
        windowStart = nil
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

}

/// Where the daemon leaves its port and token.
func handshakeURL() -> URL {
    let base = ProcessInfo.processInfo.environment["BATON_HOME"]
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".baton").path
    return URL(fileURLWithPath: base).appendingPathComponent("daemon.json")
}

final class HUDController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKScriptMessageHandler {
    private enum MenuBarState {
        case offline
        case idle
        case running
        case starting
        case failed

        var badgeColor: NSColor? {
            switch self {
            case .offline: return .tertiaryLabelColor
            case .idle: return nil
            case .running: return .systemGreen
            case .starting: return .systemOrange
            case .failed: return .systemRed
            }
        }
    }

    private var statusItem: NSStatusItem!
    private var toggleHotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private var panel: NSPanel!
    private var web: WKWebView!
    private var compactSurface: CompactChipSurface!
    private var vibrancyView: NSVisualEffectView!
    private var handshake: Handshake?
    private var loadedPort = 0
    private var timer: Timer?
    private var appearanceObserver: NSKeyValueObservation?
    private var daemonProcess: Process?
    private var attemptedDaemonStart = false
    private var daemonStartError: String?
    private var statusPage: String?
    private var healthCheckInFlight = false
    private var missedHealthChecks = 0
    private var terminationConfirmed = false
    private var terminationInProgress = false
    private var currentDensity = "chip"
    private var alwaysOnTop = UserDefaults.standard.bool(forKey: "alwaysOnTop")

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A variable-length item can collapse to zero before AppKit has lazily
        // resolved a custom image. Reserve a square slot whenever no count is
        // shown so the Baton is always present in the menu bar.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = HUDController.menuBarIcon(state: .offline)
            button.imagePosition = .imageLeading
            button.imageScaling = .scaleProportionallyDown
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)
            button.toolTip = "Baton"
            button.target = self
            button.action = #selector(statusClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        registerGlobalShortcut()

        // Leave CFBundleIconFile alone when the icns is in the bundle. Assigning
        // it to applicationIconImage flattens the icon to a low-res bitmap, which
        // is why the Dock looked right while quit and wrong once the HUD launched.
        if Bundle.main.url(forResource: "baton", withExtension: "icns") == nil {
            NSApp.applicationIconImage = HUDController.dockIcon()
        }

        buildPanel()
        loadStatusPage(
            key: "starting",
            title: "Starting Baton…",
            detail: "Reconnecting to the local runner."
        )
        refresh()
        // Cheap: one loopback request against a process that is already awake.
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        showPanel()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Closing the panel leaves the menu-bar item behind, which is the point.
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let toggleHotKey { UnregisterEventHotKey(toggleHotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationConfirmed { return .terminateNow }
        if terminationInProgress { return .terminateLater }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Quit Baton and stop all runs?"
        alert.informativeText = "Every running or starting session will be stopped, and the Baton daemon will shut down."
        alert.addButton(withTitle: "Quit and Stop All")
        alert.addButton(withTitle: "Cancel")

        guard alert.runModal() == .alertFirstButtonReturn else {
            return .terminateCancel
        }

        // With no daemon there is nothing left to stop. Otherwise wait for its
        // acknowledgement: the shutdown path owns stopAll(), including its
        // SIGKILL fallback for a child that ignores a polite stop request.
        guard handshake != nil else {
            if daemonProcess?.isRunning == true { daemonProcess?.terminate() }
            terminationConfirmed = true
            return .terminateNow
        }

        terminationInProgress = true
        timer?.invalidate()
        rpc("shutdown") { [weak self] _ in
            guard let self else { return }
            self.terminationConfirmed = true
            self.terminationInProgress = false
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// The baton, drawn rather than shipped as a bitmap.
    ///
    /// Same geometry as `assets/baton-glyph.svg`, in a 64pt box flipped to
    /// AppKit's bottom-left origin.
    static func batonGlyph(size: CGFloat = 17, color: NSColor = .labelColor) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            color.setFill()
            HUDController.fillBaton(size: size)
            return true
        }
        image.isTemplate = false
        return image
    }

    /// The Baton follows the menu-bar tint while a small state glyph reports run
    /// status. A template image is essential here: macOS chooses the correct
    /// light or dark tint for the desktop and the active menu-bar appearance.
    ///
    /// Uses bundled baton-menubar-18.png when available (Design Concept B),
    /// falling back to vector drawing. Status badge always overlays on top.
    private static func menuBarIcon(state: MenuBarState, size: CGFloat = 18) -> NSImage {
        let logicalSize = NSSize(width: size, height: size)
        let image = NSImage(size: logicalSize)
        let pixels = Int(ceil(size * 2))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels,
            pixelsHigh: pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return batonGlyph(size: size, color: .black)
        }
        rep.size = logicalSize

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.clear.setFill()
        NSRect(origin: .zero, size: logicalSize).fill(using: .copy)

        // Try bundled Design menu bar PNG first, else draw vector fallback
        if let bundled = Bundle.main.image(forResource: "baton-menubar-18") {
            bundled.draw(in: NSRect(origin: .zero, size: logicalSize),
                         from: .zero, operation: .sourceOver, fraction: 1.0)
        } else {
            NSColor.black.setFill()
            NSColor.black.setStroke()
            HUDController.fillBaton(size: size)
        }

        // Status badge overlay - do NOT skip this for any state
        if state != .idle {
            let center = NSPoint(x: size - 4.0, y: 4.0)
            let radius: CGFloat = 3.8
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(
                x: center.x - radius, y: center.y - radius,
                width: radius * 2, height: radius * 2
            )).fill()

            // Template images use alpha as a mask, so cut the state symbol out
            // of the badge instead of painting a second color over it.
            NSGraphicsContext.current?.cgContext.setBlendMode(.clear)
            NSColor.black.setStroke()
            let symbol = NSBezierPath()
            symbol.lineWidth = 1.1
            symbol.lineCapStyle = .round
            symbol.lineJoinStyle = .round
            switch state {
            case .running:
                symbol.move(to: NSPoint(x: center.x - 1.6, y: center.y))
                symbol.line(to: NSPoint(x: center.x - 0.3, y: center.y - 1.2))
                symbol.line(to: NSPoint(x: center.x + 1.8, y: center.y + 1.5))
            case .starting:
                symbol.move(to: center)
                symbol.line(to: NSPoint(x: center.x, y: center.y + 1.8))
                symbol.move(to: center)
                symbol.line(to: NSPoint(x: center.x + 1.4, y: center.y))
            case .failed:
                symbol.move(to: NSPoint(x: center.x, y: center.y - 0.6))
                symbol.line(to: NSPoint(x: center.x, y: center.y + 1.7))
            case .offline:
                symbol.move(to: NSPoint(x: center.x - 1.6, y: center.y))
                symbol.line(to: NSPoint(x: center.x + 1.6, y: center.y))
            case .idle:
                break
            }
            symbol.stroke()
            if state == .failed {
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: center.x - 0.55, y: center.y - 2.6,
                                            width: 1.1, height: 1.1)).fill()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        image.addRepresentation(rep)
        image.isTemplate = true
        return image
    }

    /// Dock / Cmd-Tab tile: the full mark on a rounded field, matching `assets/baton.svg`.
    ///
    /// Drawn into a 4× bitmap so the Dock never upscales a 1× 128px needle into
    /// jaggies. The bundle `.icns` is preferred when `npm run icons` has run.
    static func dockIcon(size: CGFloat = 128) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        let pixels = Int(size * 4)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels,
            pixelsHigh: pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return image }
        rep.size = NSSize(width: size, height: size)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        HUDController.drawDockTile(in: NSRect(origin: .zero, size: NSSize(width: size, height: size)))
        NSGraphicsContext.restoreGraphicsState()
        image.addRepresentation(rep)
        return image
    }

    /// Design Concept B: indigo→cyan gradient squircle with white baton and signal arcs.
    /// Exact geometry from `assets/baton.svg`.
    private static func drawDockTile(in rect: NSRect) {
        let size = rect.width
        let scale = size / 64
        let radius = 14.2 * scale  // Squircle corner radius from SVG rx="14.2"
        NSColor.clear.setFill()
        rect.fill(using: .copy)

        NSGraphicsContext.current?.saveGraphicsState()
        let tile = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        tile.addClip()
        
        // Indigo (#6366f1) → Cyan (#06b6d4) diagonal gradient
        NSGradient(colors: [
            NSColor(calibratedRed: 99 / 255, green: 102 / 255, blue: 241 / 255, alpha: 1),  // #6366f1
            NSColor(calibratedRed: 6 / 255, green: 182 / 255, blue: 212 / 255, alpha: 1),   // #06b6d4
        ])?.draw(from: NSPoint(x: 0, y: size), to: NSPoint(x: size, y: 0), options: [])

        let point = { (x: CGFloat, y: CGFloat) in
            NSPoint(x: x * scale, y: (64 - y) * scale)
        }

        // Three signal arcs — exact SVG arc paths converted
        NSColor.white.setStroke()
        
        // Arc 1: M26.717 27.243 A9.500 9.500 0 0 1 37.373 17.980
        let arc1 = NSBezierPath()
        arc1.lineWidth = 2.4 * scale
        arc1.lineCapStyle = .round
        arc1.appendArc(
            withCenter: point(32, 22.6),
            radius: 9.5 * scale,
            startAngle: 135, endAngle: 225
        )
        arc1.stroke()
        
        // Arc 2: M22.069 28.647 A14.200 14.200 0 0 1 39.410 13.573
        let arc2 = NSBezierPath()
        arc2.lineWidth = 2.4 * scale
        arc2.lineCapStyle = .round
        arc2.appendArc(
            withCenter: point(30.7, 21.1),
            radius: 14.2 * scale,
            startAngle: 135, endAngle: 225
        )
        arc2.stroke()
        
        // Arc 3: M17.662 31.015 A18.900 18.900 0 0 1 42.368 9.539
        let arc3 = NSBezierPath()
        arc3.lineWidth = 2.4 * scale
        arc3.lineCapStyle = .round
        arc3.appendArc(
            withCenter: point(30, 20.3),
            radius: 18.9 * scale,
            startAngle: 135, endAngle: 225
        )
        arc3.stroke()

        // White baton shaft: line x1="15.461" y1="45.451" x2="48.743" y2="16.518"
        NSColor.white.setStroke()
        NSColor.white.setFill()
        let shaft = NSBezierPath()
        shaft.lineWidth = 2.85 * scale
        shaft.lineCapStyle = .round
        shaft.move(to: point(15.461, 45.451))
        shaft.line(to: point(48.743, 16.518))
        shaft.stroke()

        // Tip bulb at top-right: circle cx="49.800" cy="15.600" r="4.0"
        let tip = point(49.8, 15.6)
        let tipRadius = 4.0 * scale
        NSBezierPath(ovalIn: NSRect(x: tip.x - tipRadius, y: tip.y - tipRadius,
                                    width: tipRadius * 2, height: tipRadius * 2)).fill()

        NSGraphicsContext.current?.restoreGraphicsState()
    }

    /// Draw Design Concept B baton: tip bulb at top-right, shaft diagonal, signal arcs left.
    /// Matches `assets/baton.svg` geometry exactly.
    private static func fillBaton(size: CGFloat) {
        let scale = size / 64
        let point = { (x: CGFloat, y: CGFloat) in
            NSPoint(x: x * scale, y: (64 - y) * scale)
        }

        // Three signal arcs (Wi-Fi/broadcast style)
        NSBezierPath.defaultLineCapStyle = .round
        let arc1 = NSBezierPath()
        arc1.lineWidth = 2.4 * scale
        arc1.appendArc(
            withCenter: point(32, 22.6),
            radius: 9.5 * scale,
            startAngle: 135, endAngle: 225
        )
        arc1.stroke()
        
        let arc2 = NSBezierPath()
        arc2.lineWidth = 2.4 * scale
        arc2.appendArc(
            withCenter: point(30.7, 21.1),
            radius: 14.2 * scale,
            startAngle: 135, endAngle: 225
        )
        arc2.stroke()
        
        let arc3 = NSBezierPath()
        arc3.lineWidth = 2.4 * scale
        arc3.appendArc(
            withCenter: point(30, 20.3),
            radius: 18.9 * scale,
            startAngle: 135, endAngle: 225
        )
        arc3.stroke()

        // Baton shaft: lower-left to upper-right diagonal
        let shaft = NSBezierPath()
        shaft.lineWidth = 2.85 * scale
        shaft.lineCapStyle = .round
        shaft.move(to: point(15.461, 45.451))
        shaft.line(to: point(48.743, 16.518))
        shaft.stroke()

        // Tip bulb at upper-right
        let tip = point(49.8, 15.6)
        let radius = 4.0 * scale
        NSBezierPath(ovalIn: NSRect(x: tip.x - radius, y: tip.y - radius,
                                    width: radius * 2, height: radius * 2)).fill()
    }

    // MARK: panel

    private func buildPanel() {
        let configuration = WKWebViewConfiguration()
        // Theme, project and layout preferences should survive app restarts.
        // The authenticated page itself is still served with no-store headers.
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(self, name: "batonHud")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 64, height: 76),
            styleMask: [.titled, .closable, .miniaturizable, .resizable,
                        .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Baton"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.isFloatingPanel = true
        panel.level = .floating
        // Compact mode follows you between desktops and full-screen apps.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        // Compact mode only needs keyboard focus for text input.
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.delegate = self

        let content = NSView()
        
        // Vibrancy effect for compact chip (hudWindow style)
        vibrancyView = NSVisualEffectView()
        vibrancyView.translatesAutoresizingMaskIntoConstraints = false
        vibrancyView.material = .hudWindow
        vibrancyView.blendingMode = .behindWindow
        vibrancyView.state = .active
        vibrancyView.wantsLayer = true
        vibrancyView.layer?.cornerRadius = 10
        vibrancyView.layer?.masksToBounds = true
        vibrancyView.isHidden = false
        
        web.translatesAutoresizingMaskIntoConstraints = false
        compactSurface = CompactChipSurface()
        compactSurface.webView = web
        compactSurface.translatesAutoresizingMaskIntoConstraints = false
        
        content.addSubview(vibrancyView)
        content.addSubview(web)
        content.addSubview(compactSurface)
        NSLayoutConstraint.activate([
            vibrancyView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            vibrancyView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            vibrancyView.topAnchor.constraint(equalTo: content.topAnchor),
            vibrancyView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            compactSurface.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            compactSurface.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            compactSurface.topAnchor.constraint(equalTo: content.topAnchor),
            compactSurface.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        panel.contentView = content
        applyChrome("chip")
        observeAppearance()
        // v2: chip-sized default. The previous autosave restored a 430pt HUD
        // and would fight the density-driven resize.
        panel.setFrameAutosaveName("BatonHUD.v2")
        if panel.frame.origin == .zero {
            if let vis = NSScreen.main?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: vis.maxX - 80, y: vis.midY - 40))
            } else {
                panel.center()
            }
        }
    }

    /// Grow or shrink the panel while keeping its trailing edge planted, so
    /// expand opens left into the screen rather than sliding the chip.
    private func pinTrailing(_ body: [String: Any]) {
        let width = cgFloat(body["width"], fallback: panel.frame.width)
        let height = cgFloat(body["height"], fallback: panel.frame.height)
        var frame = panel.frame
        let trailing = frame.maxX
        let top = frame.maxY
        frame.size.width = max(52, width)
        frame.size.height = max(52, height)
        frame.origin.x = trailing - frame.size.width
        frame.origin.y = top - frame.size.height
        if let vis = (panel.screen ?? NSScreen.main)?.visibleFrame {
            if frame.maxX > vis.maxX { frame.origin.x = vis.maxX - frame.width }
            if frame.minX < vis.minX { frame.origin.x = vis.minX }
            if frame.minY < vis.minY { frame.origin.y = vis.minY }
            if frame.maxY > vis.maxY { frame.origin.y = vis.maxY - frame.height }
        }
        panel.setFrame(frame, display: true, animate: true)
    }

    private func cgFloat(_ value: Any?, fallback: CGFloat) -> CGFloat {
        if let number = value as? Double { return CGFloat(number) }
        if let number = value as? Int { return CGFloat(number) }
        if let number = value as? NSNumber { return CGFloat(truncating: number) }
        return fallback
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "batonHud",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        DispatchQueue.main.async { [weak self] in
            if type == "resize" {
                self?.pinTrailing(body)
                if let density = body["density"] as? String {
                    self?.applyChrome(density)
                }
            } else if type == "getPreferences" {
                self?.sendPreferences()
            } else if type == "setPreference",
                      let key = body["key"] as? String,
                      let value = body["value"] as? Bool {
                self?.setPreference(key, value: value)
            } else if type == "retryDaemon" {
                self?.retryDaemon()
            }
        }
    }

    /// Chip/peek stay chrome-less; inspector gets traffic lights and a title.
    private func applyChrome(_ density: String) {
        currentDensity = density
        let compact = density != "inspector"
        let wasCompact = panel.styleMask.contains(.fullSizeContentView)
        // Transparency belongs only to the rounded launcher. The inspector's
        // native title bar needs an opaque backing, including while inactive.
        panel.titlebarAppearsTransparent = compact
        panel.isOpaque = !compact
        panel.backgroundColor = compact ? .clear : .windowBackgroundColor
        panel.isFloatingPanel = compact || alwaysOnTop
        panel.level = (compact || alwaysOnTop) ? .floating : .normal
        panel.collectionBehavior = (compact || alwaysOnTop)
            ? [.canJoinAllSpaces, .fullScreenAuxiliary] : []
        panel.becomesKeyOnlyIfNeeded = compact
        if compact {
            panel.styleMask.insert(.fullSizeContentView)
            panel.titleVisibility = .hidden
        } else {
            panel.styleMask.remove(.fullSizeContentView)
            panel.titleVisibility = .visible
        }
        panel.standardWindowButton(.closeButton)?.isHidden = compact
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = compact
        panel.standardWindowButton(.zoomButton)?.isHidden = compact
        compactSurface?.isHidden = !compact
        vibrancyView?.isHidden = !compact
        panel.hasShadow = true
        if wasCompact && !compact {
            showPanel()
        }
    }

    private func setPreference(_ key: String, value: Bool) {
        switch key {
        case "alwaysOnTop":
            alwaysOnTop = value
            UserDefaults.standard.set(value, forKey: "alwaysOnTop")
            applyChrome(currentDensity)
            sendPreferences(message: "Window preference saved.")
        case "launchAtLogin":
            guard #available(macOS 13.0, *) else {
                sendPreferences(error: "Launch at login requires macOS 13 or later.")
                return
            }
            do {
                if value { try SMAppService.mainApp.register() }
                else { try SMAppService.mainApp.unregister() }
                sendPreferences(message: "Login preference saved.")
            } catch {
                sendPreferences(error: "Could not update Launch at Login: \(error.localizedDescription)")
            }
        default:
            break
        }
    }

    private func sendPreferences(message: String? = nil, error: String? = nil) {
        var launchAtLogin = false
        if #available(macOS 13.0, *) {
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
        var payload: [String: Any] = [
            "available": true,
            "alwaysOnTop": alwaysOnTop,
            "launchAtLogin": launchAtLogin,
        ]
        if let message { payload["message"] = message }
        if let error { payload["error"] = error }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.BatonSettings && window.BatonSettings.applyNative(\(json))")
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Red traffic light hides; Quit HUD in the menu is how the process ends.
        panel.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication,
                                       hasVisibleWindows flag: Bool) -> Bool {
        // Dock click restores; it does not toggle a HUD that is already up.
        showPanel()
        return false
    }

    private var panelShown: Bool {
        panel.isVisible && !panel.isMiniaturized
    }

    private func showPanel() {
        if panel.isMiniaturized { panel.deminiaturize(nil) }
        if panel.isFloatingPanel {
            panel.orderFrontRegardless()
        } else {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private func togglePanel() {
        if panel.isMiniaturized {
            showPanel()
        } else if panel.isVisible {
            panel.orderOut(nil)
        } else {
            showPanel()
        }
    }

    /// Links marked `target="_blank"` (DevTools, a dev server URL) belong in a
    /// real browser, not in a 430pt panel.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: daemon

    private func refresh() {
        guard !terminationInProgress, !healthCheckInFlight else { return }
        let candidate = (try? Data(contentsOf: handshakeURL()))
            .flatMap { try? JSONDecoder().decode(Handshake.self, from: $0) }

        guard let candidate else {
            // Keep an already-loaded control surface steady through a brief
            // file replacement or wake-from-sleep delay. Three consecutive
            // misses still recover normally when the daemon has really gone.
            if handshake != nil {
                missedHealthChecks += 1
                if missedHealthChecks < 3 { return }
            }
            daemonUnavailable(startIfPossible: true)
            return
        }

        // Shutdown acknowledges just before the daemon finishes stopping. Check
        // that an old handshake is healthy before giving its dead port to
        // WebKit, which previously produced an empty black panel on reopen.
        guard let url = URL(string: "http://127.0.0.1:\(candidate.port)/health") else {
            daemonUnavailable(startIfPossible: false)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        healthCheckInFlight = true
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let healthy = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                guard let self, !self.terminationInProgress else { return }
                self.healthCheckInFlight = false
                if healthy {
                    self.daemonReady(candidate)
                } else {
                    if self.handshake != nil {
                        self.missedHealthChecks += 1
                        if self.missedHealthChecks < 3 { return }
                    }
                    // A live pid may still be finishing shutdown. The next poll
                    // will see its removed handshake and start a clean daemon.
                    self.daemonUnavailable(startIfPossible: kill(pid_t(candidate.pid), 0) != 0)
                }
            }
        }.resume()
    }

    private func daemonReady(_ current: Handshake) {
        let previous = handshake?.port ?? 0
        handshake = current
        missedHealthChecks = 0
        attemptedDaemonStart = false
        daemonStartError = nil
        statusPage = nil
        if current.port != previous || loadedPort != current.port {
            load(port: current.port)
        }
        rpc("sessions") { [weak self] result in
            self?.applySessions(result as? [[String: Any]] ?? [])
        }
    }

    private func daemonUnavailable(startIfPossible: Bool) {
        guard !terminationInProgress else { return }
        handshake = nil
        loadedPort = 0
        setMenuBar(count: 0, state: .starting, tooltip: "Baton — starting daemon")

        if let error = daemonStartError {
            setMenuBar(count: 0, state: .failed, tooltip: "Baton — daemon failed to start")
            loadStatusPage(
                key: "error:\(error)",
                title: "Baton couldn’t start",
                detail: error,
                retry: true
            )
            return
        }

        loadStatusPage(
            key: "starting",
            title: "Starting Baton…",
            detail: "Reconnecting to the local runner."
        )
        if startIfPossible { startDaemonIfNeeded() }
    }

    private func startDaemonIfNeeded() {
        guard !attemptedDaemonStart, !terminationInProgress else { return }
        attemptedDaemonStart = true

        guard let url = Bundle.main.url(forResource: "launcher", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let launcher = try? JSONDecoder().decode(DaemonLauncher.self, from: data) else {
            daemonStartError = "Run `baton hud` once from a terminal to rebuild the app."
            daemonUnavailable(startIfPossible: false)
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: launcher.node)
        process.arguments = [launcher.entry] + launcher.arguments
        if let log = FileHandle(forWritingAtPath: launcher.log) {
            _ = try? log.seekToEnd()
            process.standardOutput = log
            process.standardError = log
        }
        process.terminationHandler = { [weak self] process in
            guard process.terminationStatus != 0 else { return }
            DispatchQueue.main.async {
                guard let self, self.handshake == nil, !self.terminationInProgress else { return }
                self.daemonStartError = "The runner exited early. See ~/.baton/logs/daemon.log."
                self.daemonUnavailable(startIfPossible: false)
            }
        }
        do {
            try process.run()
            daemonProcess = process
        } catch {
            daemonStartError = error.localizedDescription
            daemonUnavailable(startIfPossible: false)
        }
    }

    private func load(port: Int) {
        loadedPort = port
        guard let url = URL(string: "http://127.0.0.1:\(port)/?chrome=panel") else { return }
        web.load(URLRequest(url: url))
    }

    private func loadStatusPage(key: String, title: String, detail: String, retry: Bool = false) {
        guard statusPage != key else { return }
        statusPage = key
        pinTrailing(["width": 286, "height": 154])
        let action = retry
            ? "<button onclick=\"window.webkit.messageHandlers.batonHud.postMessage({type:'retryDaemon'})\">Try again</button>"
            : "<div class=\"spinner\"></div>"
        web.loadHTMLString("""
        <meta name="color-scheme" content="dark">
        <style>
        *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;
        background:#0c0d12;color:#f0f2f7;font:13px -apple-system;text-align:center;padding:22px}
        .mark{font-size:20px;background:linear-gradient(135deg,#6366f1,#06b6d4);-webkit-background-clip:text;
        -webkit-text-fill-color:transparent;margin-bottom:10px}h1{font-size:15px;margin:0 0 7px}
        p{color:#8892a8;line-height:1.4;margin:0;max-width:235px}.spinner{width:16px;height:16px;
        border:2px solid #282d3a;border-top-color:#6366f1;border-radius:50%;margin:15px auto 0;
        animation:s .8s linear infinite}button{margin-top:15px;border:0;border-radius:7px;padding:7px 13px;
        color:white;background:linear-gradient(135deg,#6366f1,#06b6d4);font:600 12px -apple-system}
        @keyframes s{to{transform:rotate(360deg)}}
        </style><div><div class="mark">●</div><h1>\(htmlEscaped(title))</h1>
        <p>\(htmlEscaped(detail))</p>\(action)</div>
        """, baseURL: nil)
    }

    private func htmlEscaped(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    private func retryDaemon() {
        attemptedDaemonStart = false
        daemonStartError = nil
        statusPage = nil
        daemonUnavailable(startIfPossible: true)
    }

    private func applySessions(_ sessions: [[String: Any]]) {
        let statuses = sessions.compactMap { $0["status"] as? String }
        let running = statuses.filter { $0 == "running" }.count
        let starting = statuses.filter { $0 == "starting" }.count
        let failed = statuses.filter { $0 == "failed" }.count

        let live = running + starting
        let state: MenuBarState = failed > 0 ? .failed
            : starting > 0 ? .starting
            : running > 0 ? .running
            : .idle
        setMenuBar(count: live, state: state,
                   tooltip: "Baton — \(running) running, \(starting) starting, \(failed) failed")
    }

    private func setMenuBar(count: Int, state: MenuBarState, tooltip: String) {
        statusItem.length = count > 0 ? 42 : NSStatusItem.squareLength
        statusItem.button?.image = HUDController.menuBarIcon(state: state)
        statusItem.button?.attributedTitle = NSAttributedString(
            string: count > 0 ? "\(count)" : "",
            attributes: [.foregroundColor: NSColor.labelColor,
                         .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)]
        )
        statusItem.button?.toolTip = tooltip
    }

    private func rpc(_ method: String, _ params: [String: Any] = [:],
                     completion: ((Any?) -> Void)? = nil) {
        guard let current = handshake,
              let url = URL(string: "http://127.0.0.1:\(current.port)/rpc") else {
            completion?(nil)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(current.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["method": method, "params": params])

        URLSession.shared.dataTask(with: request) { data, _, _ in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            DispatchQueue.main.async { completion?(body?["result"]) }
        }.resume()
    }

    // MARK: keyboard shortcut

    /// Control-Option-B toggles Baton from any app without Accessibility or
    /// Input Monitoring permission. Carbon hot keys are old, but remain the
    /// smallest native API for a privacy-friendly global shortcut.
    private func registerGlobalShortcut() {
        let signature: OSType = 0x42544F4E // "BTON"
        let identifier = EventHotKeyID(signature: signature, id: 1)
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        let handlerStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData -> OSStatus in
                guard let event, let userData else { return OSStatus(eventNotHandledErr) }
                var pressed = EventHotKeyID()
                let readStatus = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &pressed
                )
                guard readStatus == noErr,
                      pressed.signature == 0x42544F4E,
                      pressed.id == 1 else { return OSStatus(eventNotHandledErr) }
                let controller = Unmanaged<HUDController>
                    .fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { controller.togglePanel() }
                return noErr
            },
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &hotKeyHandler
        )
        guard handlerStatus == noErr else { return }

        let modifiers = UInt32(controlKey | optionKey)
        if RegisterEventHotKey(
            UInt32(kVK_ANSI_B), modifiers, identifier,
            GetApplicationEventTarget(), 0, &toggleHotKey
        ) != noErr {
            if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
            hotKeyHandler = nil
        }
    }

    // MARK: menu

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        let secondary = event?.type == .rightMouseUp
            || event?.modifierFlags.contains(.control) == true
        if secondary {
            statusItem.menu = buildMenu()
            sender.performClick(nil)
            statusItem.menu = nil
        } else {
            togglePanel()
        }
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let toggle = item(panelShown ? "Hide Baton" : "Show Baton", #selector(menuToggle), key: "b")
        toggle.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(toggle)
        menu.addItem(.separator())
        menu.addItem(item("Hot reload all", #selector(menuReload), key: "r"))
        menu.addItem(item("Hot restart all", #selector(menuRestart), key: "R"))
        menu.addItem(item("Stop all", #selector(menuStop)))
        menu.addItem(.separator())
        menu.addItem(item("Settings…", #selector(menuSettings), key: ","))
        menu.addItem(item("Open in browser", #selector(menuBrowser)))
        menu.addItem(item("Quit Baton…", #selector(menuQuit), key: "q"))
        return menu
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        return entry
    }

    @objc private func menuToggle() { togglePanel() }
    @objc private func menuReload() { rpc("reload", ["all": true]) }
    @objc private func menuRestart() { rpc("restart", ["all": true]) }
    @objc private func menuStop() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Stop every running session?"
        alert.informativeText = "This stops all sessions across every project."
        alert.addButton(withTitle: "Stop All")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        rpc("stop", ["all": true])
    }

    @objc private func menuSettings() {
        showPanel()
        web.evaluateJavaScript(
            "window.baton && window.baton.setDensity('inspector', true); " +
            "window.BatonSettings && window.BatonSettings.open()"
        )
    }

    @objc private func menuBrowser() {
        guard let current = handshake,
              let url = URL(string: "http://127.0.0.1:\(current.port)/") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func menuQuit() { NSApp.terminate(nil) }
}

let application = NSApplication.shared
let controller = HUDController()
application.delegate = controller
// Regular: Dock tile, Cmd-Tab, and normal activation for the inspector.
application.setActivationPolicy(.regular)
application.run()
