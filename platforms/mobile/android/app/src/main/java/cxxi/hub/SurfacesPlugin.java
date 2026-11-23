package cxxi.hub;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * An isolated hubby's web surfaces on Android (docs/plan-isolation.md D3, the desktop's <webview>
 * over the frame: app/src/core/hubby/HubbySurfaces.tsx): a native WebView per surface, laid over
 * the app's WebView at the place the frame gives (CSS pixels of the app's page), its page through
 * the VPN like every WebView of the app (the process's proxy), the site's integration cookies
 * (the app's CookieManager), the player's blocklist. Its events go to the web layer ("event":
 * { id, event, detail }), which tells the frame.
 */
@CapacitorPlugin(name = "Surfaces")
public class SurfacesPlugin extends Plugin {

    private final Map<Integer, WebView> views = new HashMap<>();
    private final Map<Integer, String> sources = new HashMap<>();

    private WebView view(PluginCall call) {
        Integer id = call.getInt("id");
        return id == null ? null : views.get(id);
    }

    /**
     * show({ id, x, y, width, height, visible, src, referrer, userAgent }): the surface at that place
     * (CSS pixels of the app's page), created the first time, its page loaded when src changes.
     */
    @PluginMethod
    public void show(PluginCall call) {
        Integer id = call.getInt("id");
        String src = call.getString("src");
        if (id == null || src == null || !(src.startsWith("https://") || src.startsWith("http://"))) {
            call.reject("a surface shows an http(s) page");
            return;
        }
        getActivity().runOnUiThread(() -> {
            WebView web = views.get(id);
            if (web == null) {
                web = create(id, call.getString("userAgent"));
                views.put(id, web);
            }
            place(web, call);
            if (!src.equals(sources.get(id))) {
                sources.put(id, src);
                String referrer = call.getString("referrer");
                if (referrer != null && !referrer.isEmpty()) web.loadUrl(src, Collections.singletonMap("Referer", referrer));
                else web.loadUrl(src);
            }
            call.resolve();
        });
    }

    private void place(WebView web, PluginCall call) {
        WebView app = getBridge().getWebView();
        float density = getContext().getResources().getDisplayMetrics().density;
        double x = call.getDouble("x", 0.0), y = call.getDouble("y", 0.0);
        double w = call.getDouble("width", 0.0), h = call.getDouble("height", 0.0);
        boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", false)) && w > 0 && h > 0;
        ViewGroup.LayoutParams params = web.getLayoutParams();
        int pw = (int) Math.round(w * density), ph = (int) Math.round(h * density);
        if (params.width != pw || params.height != ph) {
            params.width = pw;
            params.height = ph;
            web.setLayoutParams(params);
        }
        web.setX(app.getX() + (float) (x * density));
        web.setY(app.getY() + (float) (y * density));
        web.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView create(int id, String userAgent) {
        WebView web = new WebView(getActivity());
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        if (userAgent != null && !userAgent.isEmpty()) web.getSettings().setUserAgentString(userAgent);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(Color.parseColor("#1E2025"));
        web.setVisibility(View.INVISIBLE);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                TunnelManager.get().handleAuth(handler, host, realm);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // ads and trackers (the back's blocklist), as the player and the desktop's surfaces do
                if (PlayerBlocklist.get(getContext()).isBlocked(request.getUrl().getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // its pages stay in it; another scheme (intent:, market:) goes nowhere
                String scheme = request.getUrl().getScheme();
                return !"http".equals(scheme) && !"https".equals(scheme);
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                JSObject detail = new JSObject();
                detail.put("url", url);
                detail.put("isMainFrame", true);
                detail.put("canGoBack", view.canGoBack());
                detail.put("canGoForward", view.canGoForward());
                emit(id, "did-navigate", detail);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                emit(id, "dom-ready", new JSObject());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                JSObject detail = new JSObject();
                // -3 is "aborted" for the desktop's webview (not a failure): Android's -3 kept apart
                int code = error.getErrorCode();
                detail.put("errorCode", code == -3 ? -1003 : code);
                detail.put("errorDescription", String.valueOf(error.getDescription()));
                detail.put("validatedURL", request.getUrl().toString());
                detail.put("isMainFrame", true);
                emit(id, "did-fail-load", detail);
            }
        });
        ViewGroup parent = (ViewGroup) getBridge().getWebView().getParent();
        parent.addView(web, new FrameLayout.LayoutParams(0, 0));
        return web;
    }

    private void emit(int id, String event, JSObject detail) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("event", event);
        e.put("detail", detail);
        notifyListeners("event", e);
    }

    /** close({ id }): the surface goes (its WebView destroyed). */
    @PluginMethod
    public void close(PluginCall call) {
        Integer id = call.getInt("id");
        getActivity().runOnUiThread(() -> {
            WebView web = id == null ? null : views.remove(id);
            sources.remove(id);
            if (web != null) {
                ((ViewGroup) web.getParent()).removeView(web);
                web.destroy();
            }
            call.resolve();
        });
    }

    /** exec({ id, code }): the code run in its page; { result } its value as JSON (null: none). */
    @PluginMethod
    public void exec(PluginCall call) {
        String code = call.getString("code", "");
        getActivity().runOnUiThread(() -> {
            WebView web = view(call);
            if (web == null) { call.reject("no such surface"); return; }
            web.evaluateJavascript(code, value -> {
                JSObject ret = new JSObject();
                ret.put("result", value);
                call.resolve(ret);
            });
        });
    }

    @PluginMethod
    public void reload(PluginCall call) { onView(call, WebView::reload); }

    @PluginMethod
    public void back(PluginCall call) { onView(call, w -> { if (w.canGoBack()) w.goBack(); }); }

    @PluginMethod
    public void forward(PluginCall call) { onView(call, w -> { if (w.canGoForward()) w.goForward(); }); }

    /** load({ id, url }): another page in it. */
    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) { call.reject("a surface loads an http(s) page"); return; }
        onView(call, w -> w.loadUrl(url));
    }

    private interface ViewAction { void run(WebView web); }

    private void onView(PluginCall call, ViewAction action) {
        getActivity().runOnUiThread(() -> {
            WebView web = view(call);
            if (web == null) { call.reject("no such surface"); return; }
            action.run(web);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (WebView web : views.values()) web.destroy();
        views.clear();
        sources.clear();
    }
}
