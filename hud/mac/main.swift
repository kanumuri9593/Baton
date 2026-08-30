// CLI-Launch HUD — a menu-bar item and a floating panel over the local daemon.
//
// The panel is an NSPanel at `.floating` level with `.canJoinAllSpaces`, so it
// stays above a full-screen terminal on every desktop, and `becomesKeyOnlyIfNeeded`
// so clicking Run never steals focus from whatever you were typing in.
//
// It hosts the same HTML the daemon serves to a browser: one control surface,
// two ways to open it.

import AppKit
import WebKit

struct Handshake: Decodable {
    let port: Int
    let token: String
    let pid: Int
}

/// Where the daemon leaves its port and token.
func handshakeURL() -> URL {
    let base = ProcessInfo.processInfo.environment["CLILAUNCH_HOME"]
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clilaunch").path
    return URL(fileURLWithPath: base).appendingPathComponent("daemon.json")
}

final class HUDController: NSObject, NSApplicationDelegate, WKUIDelegate {
    private var statusItem: NSStatusItem!
    private var panel: NSPanel!
    private var web: WKWebView!
    private var handshake: Handshake?
    private var loadedPort = 0
    private var timer: Timer?

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            button.title = "◌"
            button.toolTip = "CLI-Launch"
            button.target = self
            button.action = #selector(statusClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        buildPanel()
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

    // MARK: panel

    private func buildPanel() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 430, height: 560),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "CLI-Launch"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        // Follows you between desktops and sits above full-screen apps.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        // Take focus only for the text field, never for a button press.
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.contentView = web
        panel.setFrameAutosaveName("CLILaunchHUD")
        if panel.frame.origin == .zero {
            panel.center()
        }
    }

    private func showPanel() {
        panel.orderFrontRegardless()
    }

    private func togglePanel() {
        if panel.isVisible { panel.orderOut(nil) } else { showPanel() }
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
        let previous = handshake?.port ?? 0
        handshake = (try? Data(contentsOf: handshakeURL()))
            .flatMap { try? JSONDecoder().decode(Handshake.self, from: $0) }

        guard let current = handshake else {
            setTitle("◌", color: .disabledControlTextColor, tooltip: "CLI-Launch — daemon not running")
            if loadedPort != 0 { loadOffline() }
            return
        }
        if current.port != previous || loadedPort != current.port {
            load(port: current.port)
        }
        rpc("sessions") { [weak self] result in
            self?.applySessions(result as? [[String: Any]] ?? [])
        }
    }

    private func load(port: Int) {
        loadedPort = port
        guard let url = URL(string: "http://127.0.0.1:\(port)/?chrome=panel") else { return }
        web.load(URLRequest(url: url))
    }

    private func loadOffline() {
        loadedPort = 0
        web.loadHTMLString("""
        <body style="font:13px -apple-system;color:#8b93a7;background:#0f1115;\
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
        <div>No daemon running.<br><br>Start one with<br><code>clilaunch daemon start</code></div>
        </body>
        """, baseURL: nil)
    }

    private func applySessions(_ sessions: [[String: Any]]) {
        let statuses = sessions.compactMap { $0["status"] as? String }
        let running = statuses.filter { $0 == "running" }.count
        let starting = statuses.filter { $0 == "starting" }.count
        let failed = statuses.filter { $0 == "failed" }.count

        let live = running + starting
        let color: NSColor = failed > 0 ? .systemRed
            : starting > 0 ? .systemOrange
            : running > 0 ? .systemGreen
            : .secondaryLabelColor
        setTitle(live > 0 ? "●\(live)" : "○", color: color,
                 tooltip: "CLI-Launch — \(running) running, \(starting) starting, \(failed) failed")
    }

    private func setTitle(_ text: String, color: NSColor, tooltip: String) {
        statusItem.button?.attributedTitle = NSAttributedString(
            string: text,
            attributes: [.foregroundColor: color,
                         .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)]
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
        menu.addItem(item(panel.isVisible ? "Hide HUD" : "Show HUD", #selector(menuToggle)))
        menu.addItem(.separator())
        menu.addItem(item("Hot reload all", #selector(menuReload), key: "r"))
        menu.addItem(item("Hot restart all", #selector(menuRestart), key: "R"))
        menu.addItem(item("Stop all", #selector(menuStop)))
        menu.addItem(.separator())
        menu.addItem(item("Open in browser", #selector(menuBrowser)))
        menu.addItem(item("Quit HUD", #selector(menuQuit), key: "q"))
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
    @objc private func menuStop() { rpc("stop", ["all": true]) }

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
// Accessory: menu-bar only, no Dock icon, never activates over your terminal.
application.setActivationPolicy(.accessory)
application.run()
