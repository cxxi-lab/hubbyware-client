package cxxi.hub;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * A hubby's own icon on the phone's home screen (docs/plan-raccourcis.md): a pinned shortcut
 * opening the app on it. Its intent carries the link a tapped notification does (PushPlugin's
 * "open" event, followed by the app), so the app opens on `/<hubby>`, started or already running.
 */
@CapacitorPlugin(name = "Shortcuts")
public class ShortcutsPlugin extends Plugin {

    private static final String PREFIX = "hubby-";

    /** supported(): { supported } whether the launcher takes pinned shortcuts. */
    @PluginMethod
    public void supported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", ShortcutManagerCompat.isRequestPinShortcutSupported(getContext()));
        call.resolve(ret);
    }

    /**
     * pin({ hubby, label, icon }): asks the launcher to add the hubby's icon (`icon`: a PNG in
     * base64, the adaptive icon's full square). { requested }: the launcher's dialog was shown.
     */
    @PluginMethod
    public void pin(PluginCall call) {
        String hubby = call.getString("hubby");
        String label = call.getString("label");
        String icon = call.getString("icon");
        if (hubby == null || !hubby.matches("[a-z0-9-]+") || label == null || label.isEmpty()) {
            call.reject("a hubby id and a label are required");
            return;
        }
        Context context = getContext();
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
            call.reject("this launcher does not take shortcuts");
            return;
        }
        ShortcutInfoCompat info = shortcut(context, hubby, label, icon);
        // already pinned once: its label and icon brought up to date too
        ShortcutManagerCompat.updateShortcuts(context, List.of(info));
        boolean requested = ShortcutManagerCompat.requestPinShortcut(context, info, null);
        JSObject ret = new JSObject();
        ret.put("requested", requested);
        call.resolve(ret);
    }

    /**
     * sync({ installed: [{ hubby, label, icon }] }): the pinned shortcuts of hubbies no longer on
     * this device disabled (greyed by the launcher), those back enabled again.
     */
    @PluginMethod
    public void sync(PluginCall call) {
        Context context = getContext();
        JSArray installed = call.getArray("installed", new JSArray());
        List<ShortcutInfoCompat> present = new ArrayList<>();
        Set<String> presentIds = new HashSet<>();
        try {
            for (int i = 0; i < installed.length(); i++) {
                JSObject h = JSObject.fromJSONObject(installed.getJSONObject(i));
                String hubby = h.getString("hubby");
                if (hubby == null) continue;
                presentIds.add(PREFIX + hubby);
                present.add(shortcut(context, hubby, h.getString("label", hubby), h.getString("icon")));
            }
        }
        catch (JSONException e) {
            call.reject("bad installed list", e);
            return;
        }
        List<String> gone = new ArrayList<>();
        List<ShortcutInfoCompat> back = new ArrayList<>();
        for (ShortcutInfoCompat pinned : ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)) {
            if (!pinned.getId().startsWith(PREFIX)) continue;
            if (!presentIds.contains(pinned.getId())) gone.add(pinned.getId());
            else for (ShortcutInfoCompat p : present) if (p.getId().equals(pinned.getId())) back.add(p);
        }
        if (!gone.isEmpty()) ShortcutManagerCompat.disableShortcuts(context, gone, "Not installed on this device");
        if (!back.isEmpty()) ShortcutManagerCompat.enableShortcuts(context, back);
        JSObject ret = new JSObject();
        ret.put("pinned", back.size());
        ret.put("disabled", gone.size());
        call.resolve(ret);
    }

    private ShortcutInfoCompat shortcut(Context context, String hubby, String label, String icon) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(HubMessagingService.EXTRA_LINK, "/" + hubby);
        ShortcutInfoCompat.Builder builder = new ShortcutInfoCompat.Builder(context, PREFIX + hubby)
            .setShortLabel(label)
            .setLongLabel(label)
            .setIntent(intent);
        Bitmap bitmap = decode(icon);
        builder.setIcon(bitmap != null ? IconCompat.createWithAdaptiveBitmap(bitmap) : IconCompat.createWithResource(context, R.mipmap.ic_launcher));
        return builder.build();
    }

    private static Bitmap decode(String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        try {
            byte[] bytes = Base64.decode(base64.replaceFirst("^data:image/png;base64,", ""), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        }
        catch (IllegalArgumentException e) {
            return null;
        }
    }
}
