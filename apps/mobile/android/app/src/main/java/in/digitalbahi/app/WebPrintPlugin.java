package in.digitalbahi.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page as the browser would print it (its print styles: the A4 invoice,
 * receipt or report), through Android's printing: a printer on the network,
 * or "Save as PDF". A web view's window.print() does nothing by itself.
 */
@CapacitorPlugin(name = "WebPrint")
public class WebPrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "Digital Bahi");
        getActivity()
            .runOnUiThread(() -> {
                PrintManager manager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                WebView view = getBridge().getWebView();
                if (manager == null || view == null) {
                    call.reject("Printing is not available on this phone");
                    return;
                }
                PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(name);
                manager.print(name, adapter, new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                call.resolve();
            });
    }
}
