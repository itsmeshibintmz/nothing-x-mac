import Foundation

@main
enum ProDiscoveryTest {
    static func main() {
        let pro = UUID(), other = UUID()
        let names: Set<String> = ["Headphone (1) Pro", "Other"]
        var discovery = ProDiscovery()
        discovery.deferAttempt(id: pro, name: "Headphone (1) Pro", now: 100)
        precondition(!discovery.allows(pro) && discovery.allows(other))
        discovery.update(connectedNames: names, now: 114)
        precondition(!discovery.allows(pro))
        discovery.update(connectedNames: names, now: 115)
        precondition(discovery.allows(pro), "Missing services must become discoverable again.")

        discovery.deferAttempt(id: pro, name: "Headphone (1) Pro", now: 116)
        discovery.deferAttempt(id: other, name: "Other", now: 116, otherModel: true)
        discovery.update(connectedNames: ["Other"], now: 117)
        discovery.update(connectedNames: names, now: 118)
        precondition(discovery.allows(pro), "Reconnect must clear the old attempt immediately.")
        precondition(!discovery.allows(other), "A different peripheral must keep its own delay.")
        discovery.update(connectedNames: names, now: 416)
        precondition(discovery.allows(other))
    }
}
