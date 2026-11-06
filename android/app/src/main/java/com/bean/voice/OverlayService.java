package com.bean.voice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.core.app.ServiceCompat;

import ai.picovoice.porcupine.PorcupineException;
import ai.picovoice.porcupine.PorcupineManager;

/**
 * Foreground service. It shows the assistant as a floating panel at the top of the screen and,
 * when a wake phrase is set up, listens for it in the background while the panel is hidden.
 */
public class OverlayService extends Service implements VoiceBridge.Host {

    public static final String ACTION_SHOW = "com.bean.voice.SHOW";
    public static final String ACTION_HIDE = "com.bean.voice.HIDE";
    public static final String ACTION_TOGGLE = "com.bean.voice.TOGGLE";
    public static final String ACTION_WAKE_SYNC = "com.bean.voice.WAKE_SYNC";

    /** True while the service is alive (panel showing or listening for the wake phrase). */
    public static volatile boolean running = false;

    private static final String CHANNEL = "voice_overlay";

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private FrameLayout root;
    private WebView web;
    private VoiceBridge bridge;
    private boolean shown = false;
    private PorcupineManager porcupine;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        startAsForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (a == null) {
            if (!shown && !Wake.ready(this)) stopSelf();
            return START_NOT_STICKY;
        }
        switch (a) {
            case ACTION_SHOW:
                if (!shown) showNow();
                break;
            case ACTION_HIDE:
                if (shown) hideNow();
                break;
            case ACTION_TOGGLE:
                if (shown) hideNow(); else showNow();
                break;
            case ACTION_WAKE_SYNC:
                if (!shown) {
                    stopWake();
                    if (Wake.ready(this)) startWake(); else stopSelf();
                }
                break;
            default:
                break;
        }
        return START_NOT_STICKY;
    }

    // ---------------------------------------------------------------- notification

    private void startAsForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Voice assistant", NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);

        Intent toggle = new Intent(this, MainActivity.class);
        toggle.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, toggle, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Voice assistant")
                .setContentText("Tap to open or close")
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        ServiceCompat.startForeground(this, 1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    }

    // ---------------------------------------------------------------- wake phrase

    private void startWake() {
        if (porcupine != null || !Wake.ready(this)) return;
        try {
            porcupine = new PorcupineManager.Builder()
                    .setAccessKey(Wake.prefs(this).getString("key", ""))
                    .setKeywordPath(Wake.file(this).getAbsolutePath())
                    .setSensitivity(0.65f)
                    .build(this, idx -> main.post(() -> {
                        if (!shown) showNow();
                    }));
            porcupine.start();
        } catch (PorcupineException e) {
            porcupine = null;
            Toast.makeText(this, "Wake phrase failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            stopSelf();
        }
    }

    private void stopWake() {
        PorcupineManager p = porcupine;
        porcupine = null;
        if (p != null) {
            try { p.stop(); } catch (Exception ignored) { }
            try { p.delete(); } catch (Exception ignored) { }
        }
    }

    // ---------------------------------------------------------------- panel

    private void showNow() {
        stopWake(); // free the microphone for speech recognition
        try {
            addPanel();
            shown = true;
        } catch (Exception e) {
            removePanel();
            shown = false;
            if (Wake.ready(this)) startWake(); else stopSelf();
        }
    }

    private void hideNow() {
        removePanel();
        shown = false;
        if (Wake.ready(this)) startWake(); else stopSelf();
    }

    private void addPanel() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        final float d = getResources().getDisplayMetrics().density;
        final int height = (int) (getResources().getDisplayMetrics().heightPixels * 0.48f);

        root = new FrameLayout(this) {
            @Override
            public boolean dispatchKeyEvent(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                    if (e.getAction() == KeyEvent.ACTION_UP) closeOverlay();
                    return true;
                }
                return super.dispatchKeyEvent(e);
            }
        };
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF0B0D12);
        float r = 22 * d;
        bg.setCornerRadii(new float[]{0, 0, 0, 0, r, r, r, r});
        root.setBackground(bg);
        root.setClipToOutline(true);

        web = new WebView(this);
        bridge = VoiceBridge.attach(this, web, this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                height,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        wm.addView(root, lp);

        web.loadUrl(VoiceBridge.BASE_URL + "index.html?overlay=1&listen=1");
    }

    private void removePanel() {
        try {
            if (root != null && wm != null) wm.removeView(root);
        } catch (Exception ignored) { }
        if (web != null) {
            try { web.evaluateJavascript("window.__voiceStop&&window.__voiceStop()", null); } catch (Exception ignored) { }
            web.destroy();
        }
        if (bridge != null) bridge.shutdown();
        root = null;
        web = null;
        bridge = null;
    }

    @Override
    public void closeOverlay() {
        main.post(() -> { if (shown) hideNow(); });
    }

    @Override
    public void openFull() {
        main.post(() -> {
            Intent i = new Intent(this, FullActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            if (shown) hideNow();
        });
    }

    @Override
    public void onDestroy() {
        running = false;
        stopWake();
        removePanel();
        super.onDestroy();
    }
}
