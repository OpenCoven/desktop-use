import Foundation
import Darwin

// Optional fixture instrumentation only. No AppKit, input or desktop APIs.
enum FixtureContinuousClock {
    private static let timebase: mach_timebase_info_data_t = {
        var value = mach_timebase_info_data_t()
        precondition(mach_timebase_info(&value) == KERN_SUCCESS && value.denom > 0)
        return value
    }()
    static func nowNanoseconds() -> UInt64 {
        // Match libuv 1.52.1's Darwin uv__hrtime, including system sleep.
        mach_continuous_time() &* UInt64(timebase.numer) / UInt64(timebase.denom)
    }
}

final class FixtureControlTimeline {
    enum Kind: String, Codable { case text, scroll, key, click }
    struct Event: Codable, Equatable {
        let sequence: Int
        let kind: Kind
        let continuousNs: String
        let textUtf16Length: Int
        let scrollOffset: Int
        let keyCount: Int
        let clickCount: Int
    }
    struct Snapshot: Codable {
        let schemaVersion: Int
        let clockDomain: String
        let publishedContinuousNs: String
        let events: [Event]
        let droppedEvents: Int
    }
    private(set) var events: [Event] = []
    private(set) var droppedEvents = 0
    private let limit: Int
    private let clock: () -> UInt64
    init(limit: Int = 100_000, clock: @escaping () -> UInt64 = FixtureContinuousClock.nowNanoseconds) {
        precondition(limit > 0)
        self.limit = limit
        self.clock = clock
    }
    func record(_ kind: Kind, textUtf16Length: Int, scrollOffset: Int, keyCount: Int, clickCount: Int) {
        guard events.count < limit else { droppedEvents += 1; return }
        events.append(Event(sequence: events.count + 1, kind: kind, continuousNs: String(clock()), textUtf16Length: textUtf16Length, scrollOffset: scrollOffset, keyCount: keyCount, clickCount: clickCount))
    }
    func snapshot() -> Snapshot {
        Snapshot(schemaVersion: 1, clockDomain: "darwin-mach-continuous-nanoseconds", publishedContinuousNs: String(clock()), events: events, droppedEvents: droppedEvents)
    }
}

final class FixtureStateWriter {
    private let schedule: (@escaping () -> Void) -> Void
    private let write: () -> Void
    private var pending = false
    init(schedule: @escaping (@escaping () -> Void) -> Void, write: @escaping () -> Void) {
        self.schedule = schedule
        self.write = write
    }
    func request() {
        guard !pending else { return }
        pending = true
        schedule { [weak self] in self?.flushPending() }
    }
    func flushPending() {
        guard pending else { return }
        pending = false
        write()
    }
}
