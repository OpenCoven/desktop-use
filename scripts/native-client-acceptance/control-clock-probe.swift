import Foundation

// Clock-only executable: never imports AppKit or launches a fixture/helper.
@main
enum ControlClockProbe {
    static func main() { print(FixtureContinuousClock.nowNanoseconds()) }
}
