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

import androidx.core.app.ServiceCompat;

/** Foreground service that shows the assistant as a floating panel at the top of the screen. */
public class OverlayService extends Service implements VoiceBridge.Host {

    public static volatile boolean running = false;

    private static final String CHANNEL = "voice_overlay";

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private FrameLayout root;
    private WebView web;
    private VoiceBridge bridge;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        startAsForeground();
        try {
            showPanel();
        } catch (Exception e) {
            stopSelf();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY;
    }

    private void startAsForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Voice overlay", NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);

        Intent toggle = new Intent(this, MainActivity.class);
        toggle.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, toggle, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Voice assistant is open")
                .setContentText("Tap to close")
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        ServiceCompat.startForeground(this, 1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    }

    private void showPanel() {
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

    @Override
    public void closeOverlay() {
        main.post(this::stopSelf);
    }

    @Override
    public void openFull() {
        main.post(() -> {
            Intent i = new Intent(this, FullActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            stopSelf();
        });
    }

    @Override
    public void onDestroy() {
        running = false;
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
        super.onDestroy();
    }
}
