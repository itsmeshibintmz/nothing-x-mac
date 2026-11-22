// The contract between the bridge and a platform's Bluetooth transport.
// Nothing here depends on the app shell, so a transport is plain OS code.

/// What a transport reports back.
pub trait Events: Send + Sync {
    /// A channel to the earbuds is open. `name` is the device's Bluetooth name.
    fn connected(&self, name: &str, address: &str);
    /// Bytes received from the earbuds.
    fn data(&self, bytes: &[u8]);
    /// The channel closed.
    fn disconnected(&self);
    fn log(&self, message: &str);
}

/// A running transport. It finds the earbuds, keeps a channel open and
/// reconnects on its own.
pub trait Transport: Send + Sync {
    /// Sends bytes to the earbuds; ignored while not connected.
    fn write(&self, bytes: &[u8]);
    /// Closes the channel cleanly and stops reconnecting.
    fn stop(&self);
}
