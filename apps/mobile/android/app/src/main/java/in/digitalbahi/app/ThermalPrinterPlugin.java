package in.digitalbahi.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Receipt printers over classic Bluetooth: most small thermal printers speak
 * the serial port profile (SPP) the browser cannot reach. The printers paired
 * with the phone, and bytes (ESC/POS, base64) sent to one of them.
 */
@CapacitorPlugin(name = "ThermalPrinter", permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) })
public class ThermalPrinterPlugin extends Plugin {

    private static final UUID SERIAL_PORT = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int CHUNK = 512;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** Android 12 and later ask the person before an app may use paired devices. */
    private boolean needsPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "listWithPermission");
            return;
        }
        listPaired(call);
    }

    @PermissionCallback
    private void listWithPermission(PluginCall call) {
        if (needsPermission()) {
            call.reject("Bluetooth was not allowed", "PERMISSION_DENIED");
            return;
        }
        listPaired(call);
    }

    @SuppressLint("MissingPermission")
    private void listPaired(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This phone has no Bluetooth", "UNSUPPORTED");
            return;
        }
        JSArray devices = new JSArray();
        for (BluetoothDevice device : adapter.getBondedDevices()) {
            JSObject d = new JSObject();
            d.put("name", device.getName() == null ? "" : device.getName());
            d.put("address", device.getAddress());
            devices.put(d);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void print(PluginCall call) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", call, "printWithPermission");
            return;
        }
        send(call);
    }

    @PermissionCallback
    private void printWithPermission(PluginCall call) {
        if (needsPermission()) {
            call.reject("Bluetooth was not allowed", "PERMISSION_DENIED");
            return;
        }
        send(call);
    }

    @SuppressLint("MissingPermission")
    private void send(PluginCall call) {
        String address = call.getString("address");
        String data = call.getString("data");
        BluetoothAdapter adapter = adapter();
        if (address == null || data == null) {
            call.reject("The printer and what to print are needed");
            return;
        }
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off", "UNSUPPORTED");
            return;
        }
        final byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        io.execute(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothDevice device = adapter.getRemoteDevice(address);
                adapter.cancelDiscovery();
                socket = connect(device);
                OutputStream out = socket.getOutputStream();
                for (int i = 0; i < bytes.length; i += CHUNK) {
                    out.write(bytes, i, Math.min(CHUNK, bytes.length - i));
                    out.flush();
                    // Small printers have small buffers.
                    Thread.sleep(8);
                }
                // Let the printer take in the last bytes before the link closes.
                Thread.sleep(500);
                call.resolve();
            } catch (IOException | IllegalArgumentException e) {
                call.reject("The printer did not take the data: " + e.getMessage(), "WRITE_FAILED");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                call.reject("Printing was interrupted", "WRITE_FAILED");
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (IOException ignored) {
                        // Closed already.
                    }
                }
            }
        });
    }

    /** The serial link, secure first; some cheap printers only take the insecure one. */
    @SuppressLint("MissingPermission")
    private BluetoothSocket connect(BluetoothDevice device) throws IOException {
        BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SERIAL_PORT);
        try {
            socket.connect();
            return socket;
        } catch (IOException first) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Retried below.
            }
            BluetoothSocket insecure = device.createInsecureRfcommSocketToServiceRecord(SERIAL_PORT);
            insecure.connect();
            return insecure;
        }
    }
}
