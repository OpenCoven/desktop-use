import Foundation
import Darwin

@main
enum ControlObservationTests {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fputs(message + "\n", stderr); exit(EXIT_FAILURE) }
    }
    static func main() throws {
        // Exact decimal strings must survive JSON beyond JavaScript's integer precision.
        var clock: UInt64 = 9_007_199_254_740_992
        let timeline = FixtureControlTimeline(clock: { clock += 1; return clock })
        timeline.record(.text, textUtf16Length: 1, scrollOffset: 0, keyCount: 0, clickCount: 2)
        timeline.record(.scroll, textUtf16Length: 1, scrollOffset: 17, keyCount: 0, clickCount: 2)
        expect(timeline.events.count == 2, "actual control callbacks must be retained immediately")
        expect(timeline.events.map(\.continuousNs) == ["9007199254740993", "9007199254740994"], "callback times must retain integer precision and event order")
        expect(timeline.events.map(\.sequence) == [1, 2], "control history must have consecutive sequence numbers")
        expect(timeline.events[1].kind == .scroll && timeline.events[1].scrollOffset == 17, "actual scroll effects must stay distinct from text")
        let encoded = try JSONEncoder().encode(timeline.snapshot())
        let decoded = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        let events = decoded["events"] as! [[String: Any]]
        expect(events[0]["continuousNs"] as? String == "9007199254740993", "JSON must retain nanoseconds as strings")
        expect(Set(events[0].keys) == Set(["sequence", "kind", "continuousNs", "textUtf16Length", "scrollOffset", "keyCount", "clickCount"]), "observer records must contain only allowlisted scalar fields")

        let bounded = FixtureControlTimeline(limit: 1, clock: { 10 })
        bounded.record(.key, textUtf16Length: 0, scrollOffset: 0, keyCount: 1, clickCount: 0)
        bounded.record(.key, textUtf16Length: 0, scrollOffset: 0, keyCount: 2, clickCount: 0)
        expect(bounded.events.count == 1 && bounded.snapshot().droppedEvents == 1, "a bounded observer must expose every dropped record instead of claiming complete history")

        let firstClock = FixtureContinuousClock.nowNanoseconds()
        let secondClock = FixtureContinuousClock.nowNanoseconds()
        expect(firstClock > 0 && secondClock >= firstClock, "the production clock must provide nondecreasing continuous nanoseconds")

        var pending: [() -> Void] = []
        var writes = 0
        let writer = FixtureStateWriter(schedule: { pending.append($0) }, write: { writes += 1 })
        for _ in 0..<1_000 { writer.request() }
        expect(writes == 0 && pending.count == 1, "an event burst must schedule one later write without callback-time serialization")
        pending.removeFirst()()
        expect(writes == 1, "the scheduled flush must publish once")
        writer.request()
        writer.flushPending()
        writer.flushPending()
        expect(writes == 2, "shutdown must flush a pending write exactly once")
        pending.removeFirst()()
        expect(writes == 2, "a stale scheduled callback must not write again after a shutdown flush")

        var reentrantPending: [() -> Void] = []
        var reentrantWrites = 0
        var reentrant: FixtureStateWriter!
        reentrant = FixtureStateWriter(schedule: { reentrantPending.append($0) }, write: {
            reentrantWrites += 1
            if reentrantWrites == 1 { reentrant.request() }
        })
        reentrant.request()
        reentrantPending.removeFirst()()
        expect(reentrantPending.count == 1, "a change during publication must schedule another write")
        reentrantPending.removeFirst()()
        expect(reentrantWrites == 2, "reentrant publication must not lose the next state")
        print("Control timeline, precision, bounded history, continuous clock and coalesced writer checks passed")
    }
}
