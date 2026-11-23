package cxxi.hub;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(VpnPlugin.class);
        registerPlugin(PlayerPlugin.class);
        registerPlugin(IntegrationsPlugin.class);
        registerPlugin(SessionPlugin.class);
        registerPlugin(DeviceSecretsPlugin.class);
        registerPlugin(HubbiesPlugin.class);
        registerPlugin(PushPlugin.class);
        registerPlugin(LocalStorePlugin.class);
        registerPlugin(ThemePlugin.class);
        registerPlugin(LocalAiPlugin.class);
        registerPlugin(SurfacesPlugin.class);
        // Which version of each hubby this session runs (built in, or a downloaded newer one).
        HubbyStore.get().setup(this);
        // The tunnel only carries Private: it starts with private mode (the web side, VpnPlugin).
        super.onCreate(savedInstanceState);
        // reopened after an update: its "tap to open" notification goes
        UpdatedReceiver.opened(this);
        // The system bars in the app's theme as last shown (ThemePlugin), not the phone's.
        ThemePlugin.apply(this, ThemePlugin.isDark(this));
        getBridge().setWebViewClient(new TunnelWebViewClient(getBridge()));
        // The back button: the app first (it closes a menu, a modal, the drawer, or goes back a
        // page: window.hubBack, app/src/shared/back.ts); nothing left to close, hub goes to the
        // background (kept running, like the home button) instead of being closed.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                    "(function () { try { return !!(window.hubBack && window.hubBack()) } catch (e) { return false } })()",
                    handled -> { if (!"true".equals(handled)) moveTaskToBack(true); }
                );
            }
        });
    }

    @Override
    public void onPause() {
        super.onPause();
        // A backgrounded app may be killed without notice: write the cookies
        // (the rotating refresh token) now, see SessionPlugin.
        CookieManager.getInstance().flush();
    }

    @Override
    public void onStop() {
        super.onStop();
        // the launcher icon in the accent chosen, now that the app is out of sight (ThemePlugin)
        ThemePlugin.applyIcon(this);
    }

    /** Answers the tunnel proxy's 407 for the app's own WebView, and serves the hubbies' versions. */
    private static class TunnelWebViewClient extends BridgeWebViewClient {
        private final Bridge bridge;

        TunnelWebViewClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            TunnelManager.get().handleAuth(handler, host, realm);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // an isolated hubby's frame (https://<id>.hubby.localhost/): served from the app, never the network
            if (HubbyStore.isHubbyHost(request.getUrl().getHost())) {
                return HubbyStore.get().interceptHubby(request.getUrl().getHost(), request.getUrl().getPath());
            }
            if (request.getUrl().getHost() != null && request.getUrl().getHost().equals(bridge.getHost())) {
                WebResourceResponse hubby = HubbyStore.get().intercept(request.getUrl().getPath());
                if (hubby != null) return hubby;
            }
            return super.shouldInterceptRequest(view, request);
        }
    }
}
