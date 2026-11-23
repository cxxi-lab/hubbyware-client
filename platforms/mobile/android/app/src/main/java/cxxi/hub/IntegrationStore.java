package cxxi.hub;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Website integrations, the Android counterpart of desktop's
 * session/integrations.ts: per site host, the cookies to set, which go into the
 * process-wide CookieManager so the native player sees them. The CDN referer
 * rule is stored but not applied: a WebView can't rewrite its subresource
 * headers, and re-issuing those requests natively broke playback (signed
 * stream URLs answered 410) while the WebView plays fine on its own. Entries are
 * cached in SharedPreferences, like desktop's integrations-cache.json, so
 * `list()` survives restarts.
 */
final class IntegrationStore {

    private static final String TAG = "hub-integrations";
    private static final String PREFS = "integrations";
    private static final int ONE_YEAR_SEC = 365 * 24 * 3600;

    private static IntegrationStore instance;

    static synchronized IntegrationStore get(Context context) {
        if (instance == null) instance = new IntegrationStore(context.getApplicationContext());
        return instance;
    }

    private final SharedPreferences prefs;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private IntegrationStore(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Hosts known to the shell, with the server-side timestamp they were applied at. */
    synchronized List<JSONObject> list() {
        List<JSONObject> out = new ArrayList<>();
        for (String host : prefs.getAll().keySet()) {
            try {
                JSONObject entry = new JSONObject(prefs.getString(host, "{}"));
                out.add(new JSONObject().put("host", host).put("updatedAt", entry.optLong("updatedAt")));
            } catch (Exception e) {
                Log.w(TAG, "corrupt entry for " + host, e);
            }
        }
        return out;
    }

    void apply(String host, JSONObject integration, long updatedAt) throws Exception {
        synchronized (this) {
            prefs.edit()
                .putString(host, new JSONObject().put("integration", integration).put("updatedAt", updatedAt).toString())
                .apply();
        }
        JSONArray cookies = integration.optJSONArray("cookies");
        if (cookies == null) return;
        List<String> values = new ArrayList<>();
        for (int i = 0; i < cookies.length(); i++) {
            JSONObject c = cookies.getJSONObject(i);
            // a cookie for other devices only (`devices` without "phone": a desktop layout's): removed here
            JSONArray devices = c.optJSONArray("devices");
            boolean forPhone = devices == null;
            for (int d = 0; devices != null && d < devices.length(); d++) if ("phone".equals(devices.optString(d))) forPhone = true;
            values.add(forPhone
                ? c.getString("name") + "=" + c.getString("value") + "; Domain=." + host + "; Path=/; Secure; Max-Age=" + ONE_YEAR_SEC
                : c.getString("name") + "=; Domain=." + host + "; Path=/; Secure; Max-Age=0");
        }
        setCookies(host, values);
        Log.i(TAG, "applied " + host + " (" + values.size() + " cookie(s)"
            + (integration.optJSONObject("referer") != null ? ", referer rule" : "") + ")");
    }

    void remove(String host) throws Exception {
        String raw;
        synchronized (this) {
            raw = prefs.getString(host, null);
            prefs.edit().remove(host).apply();
        }
        if (raw == null) return;
        JSONArray cookies = new JSONObject(raw).getJSONObject("integration").optJSONArray("cookies");
        if (cookies == null) return;
        List<String> values = new ArrayList<>();
        for (int i = 0; i < cookies.length(); i++) {
            values.add(cookies.getJSONObject(i).getString("name") + "=; Domain=." + host + "; Path=/; Secure; Max-Age=0");
        }
        setCookies(host, values);
    }

    /** CookieManager wants the main thread (and an initialised WebView); waits until flushed. */
    private void setCookies(String host, List<String> values) throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        mainHandler.post(() -> {
            CookieManager cm = CookieManager.getInstance();
            for (String v : values) {
                cm.setCookie("https://www." + host, v);
                cm.setCookie("https://" + host, v);
            }
            cm.flush();
            latch.countDown();
        });
        latch.await(5, TimeUnit.SECONDS);
    }
}
