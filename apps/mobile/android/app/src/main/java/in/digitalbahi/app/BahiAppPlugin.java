package in.digitalbahi.app;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What this build of the app has. Push needs the business's Firebase project
 * (its google-services.json at build time); without it, asking Firebase for
 * a token would stop the app, so the page asks here first.
 */
@CapacitorPlugin(name = "BahiApp")
public class BahiAppPlugin extends Plugin {

    @PluginMethod
    public void config(PluginCall call) {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("push", context.getResources().getIdentifier("google_app_id", "string", context.getPackageName()) != 0);
        try {
            result.put("version", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName);
        } catch (Exception e) {
            result.put("version", "");
        }
        call.resolve(result);
    }
}
