// B192 exposes the Nothing protocol on this GATT service on macOS. Restrict
// discovery to system-connected peripherals and verify the Fast Pair model ID.
import CoreBluetooth
import Foundation

final class ProBluetooth: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let control = CBUUID(string: "FD90")
    private let fastPair = CBUUID(string: "FE2C")
    private let modelID = CBUUID(string: "FE2C1233-8366-4814-8EB0-01DE32100BEA")
    private let txID = CBUUID(string: "68745353-1810-4B13-83A2-C1B21B652C9B")
    private let rxID = CBUUID(string: "CA235943-1810-45E6-8326-FC8CA3BC45CE")
    private lazy var central = CBCentralManager(delegate: self, queue: .main)
    private var peripheral: CBPeripheral?
    private var tx: CBCharacteristic?
    private var rx: CBCharacteristic?
    private var modelVerified = false
    private var ready = false
    private var writing = false
    private var queue: [Data] = []
    private var discovery = ProDiscovery()
    private var nextAttempt: TimeInterval = 0
    private var deadline: TimeInterval = 0

    var active: Bool { peripheral != nil }

    func scan(connectedNames: Set<String>) {
        let now = ProcessInfo.processInfo.systemUptime
        discovery.update(connectedNames: connectedNames, now: now)
        if let p = peripheral {
            if !connectedNames.contains(p.name ?? "") { close() }
            else if !ready && now >= deadline { deferDiscovery(p) }
            return
        }
        guard !connectedNames.isEmpty, central.state == .poweredOn, now >= nextAttempt else { return }
        // The vendor service may not be cached yet on a newly paired Mac.
        func eligible(_ p: CBPeripheral) -> Bool {
            connectedNames.contains(p.name ?? "") && discovery.allows(p.identifier)
        }
        let preferred = central.retrieveConnectedPeripherals(withServices: [control]).first(where: eligible)
        let candidate = preferred ?? central.retrieveConnectedPeripherals(withServices: [fastPair, CBUUID(string: "1800")])
            .first { eligible($0) && $0.name?.localizedCaseInsensitiveContains("Headphone (1) Pro") == true }
        guard let p = candidate else { return }
        peripheral = p
        deadline = now + 12
        p.delegate = self
        central.connect(p)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state != .poweredOn { discovery = ProDiscovery(); clear() }
    }

    private func deferDiscovery(_ p: CBPeripheral, otherModel: Bool = false) {
        discovery.deferAttempt(id: p.identifier, name: p.name ?? "",
                               now: ProcessInfo.processInfo.systemUptime, otherModel: otherModel)
        close()
    }

    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        guard p === peripheral else { return }
        p.discoverServices([control, fastPair])
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p === peripheral else { return }
        guard error == nil, let services = p.services,
              services.contains(where: { $0.uuid == control }), services.contains(where: { $0.uuid == fastPair }) else {
            deferDiscovery(p); return
        }
        for s in services where s.uuid == control || s.uuid == fastPair {
            p.discoverCharacteristics(s.uuid == control ? [rxID, txID] : [modelID], for: s)
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p === peripheral else { return }
        guard error == nil, let chars = service.characteristics else { deferDiscovery(p); return }
        if service.uuid == fastPair {
            guard let id = chars.first(where: { $0.uuid == modelID }) else {
                deferDiscovery(p); return
            }
            p.readValue(for: id)
        } else if service.uuid == control {
            tx = chars.first { $0.uuid == txID && $0.properties.contains(.write) }
            rx = chars.first { $0.uuid == rxID && $0.properties.contains(.notify) }
            guard tx != nil, rx != nil else { deferDiscovery(p); return }
            subscribeIfReady(p)
        }
    }

    private func subscribeIfReady(_ p: CBPeripheral) {
        if modelVerified, tx != nil, let rx { p.setNotifyValue(true, for: rx) }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard p === peripheral else { return }
        if c.uuid == modelID {
            guard error == nil, let data = c.value else { deferDiscovery(p); return }
            // Fast Pair specifies a 3-byte ID. The Pro also reports it as a little-endian uint32.
            let id: [UInt8]
            if data.count == 4 && data.last == 0 { id = Array(data.prefix(3).reversed()) }
            else if data.count == 3 { id = Array(data) }
            else { deferDiscovery(p); return }
            guard id == [0x08, 0x64, 0x85] || id == [0xCD, 0xFD, 0xEC] else {
                deferDiscovery(p, otherModel: true); return
            }
            modelVerified = true
            subscribeIfReady(p)
        } else if c.uuid == rxID && ready, error == nil, let data = c.value {
            emit(["type": "data", "hex": data.map { String(format: "%02x", $0) }.joined()])
        }
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        guard p === peripheral, c.uuid == rxID else { return }
        guard error == nil && c.isNotifying && modelVerified else { deferDiscovery(p); return }
        ready = true
        emit(["type": "connected", "name": p.name ?? "Nothing Headphone (1) Pro",
              "address": p.identifier.uuidString, "modelId": "B192"])
    }

    func write(_ bytes: [UInt8]) {
        guard ready, let p = peripheral else { return }
        let limit = p.maximumWriteValueLength(for: .withResponse)
        guard limit > 0 else { close(); return }
        for start in stride(from: 0, to: bytes.count, by: limit) {
            queue.append(Data(bytes[start..<min(bytes.count, start + limit)]))
        }
        writeNext()
    }

    private func writeNext() {
        guard !writing, !queue.isEmpty, let p = peripheral, let tx else { return }
        writing = true
        p.writeValue(queue.removeFirst(), for: tx, type: .withResponse)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        guard p === peripheral, c.uuid == txID else { return }
        guard error == nil else { close(); return }
        writing = false
        writeNext()
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        connectionEnded(p)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        connectionEnded(p)
    }

    private func connectionEnded(_ p: CBPeripheral) {
        guard p === peripheral else { return }
        if !ready {
            discovery.deferAttempt(id: p.identifier, name: p.name ?? "", now: ProcessInfo.processInfo.systemUptime)
        }
        clear()
    }

    func close() {
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        clear()
    }

    private func clear() {
        if ready { emit(["type": "disconnected"]) }
        peripheral?.delegate = nil
        peripheral = nil
        tx = nil
        rx = nil
        modelVerified = false
        ready = false
        writing = false
        queue.removeAll()
        nextAttempt = ProcessInfo.processInfo.systemUptime + 1
    }
}
