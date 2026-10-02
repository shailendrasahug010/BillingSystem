package in.digitalbahi.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (the npm ones register themselves).
        registerPlugin(ThermalPrinterPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(WebPrintPlugin.class);
        registerPlugin(BahiAppPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
