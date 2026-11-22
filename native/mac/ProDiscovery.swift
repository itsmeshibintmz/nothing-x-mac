import Foundation

// Core Bluetooth can expose an incomplete service list before the audio link settles.
// Back off per peripheral so one incomplete device cannot monopolise discovery.
struct ProDiscovery {
    private var deferred: [UUID: (name: String, until: TimeInterval)] = [:]

    mutating func update(connectedNames: Set<String>, now: TimeInterval) {
        deferred = deferred.filter { connectedNames.contains($0.value.name) && now < $0.value.until }
    }

    mutating func deferAttempt(id: UUID, name: String, now: TimeInterval, otherModel: Bool = false) {
        deferred[id] = (name, now + (otherModel ? 300 : 15))
    }

    func allows(_ id: UUID) -> Bool { deferred[id] == nil }
}
