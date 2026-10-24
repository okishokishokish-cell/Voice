package com.bean.voice;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Exposes the phone's speech recogniser and text-to-speech engine to the web UI as window.AndroidBridge. */
public class VoiceBridge {

    public interface Host {
        void closeOverlay();
        void openFull();
    }

    public static final String BASE_URL = "https://appassets.androidplatform.net/assets/www/";

    private final Context ctx;
    private final WebView web;
    private final Host host;
    private final Handler main = new Handler(Looper.getMainLooper());

    private SpeechRecognizer sr;

    private TextToSpeech tts;
    private boolean ttsReady;
    private String ttsLang = "";
    private final List<Runnable> ttsPending = new ArrayList<>();

    private VoiceBridge(Context ctx, WebView web, Host host) {
        this.ctx = ctx;
        this.web = web;
        this.host = host;
    }

    /** Configures the WebView, installs the bridge, and returns it. Call before loadUrl. */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    public static VoiceBridge attach(Context ctx, WebView web, Host host) {
        final VoiceBridge b = new VoiceBridge(ctx, web, host);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(ctx))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setBackgroundColor(0xFF0B0D12);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        web.addJavascriptInterface(b, "AndroidBridge");

        b.main.post(b::initTts);
        return b;
    }

    // ---------------------------------------------------------------- JS -> native

    @JavascriptInterface
    public void startListening(final String lang) {
        main.post(() -> doStartListening(lang));
    }

    @JavascriptInterface
    public void stopListening() {
        main.post(() -> {
            if (sr != null) {
                try { sr.stopListening(); } catch (Exception ignored) { }
            }
        });
    }

    @JavascriptInterface
    public void cancelListening() {
        main.post(this::destroyRecognizer);
    }

    @JavascriptInterface
    public void speak(final String id, final String text, final float rate, final String lang) {
        main.post(() -> {
            Runnable job = () -> doSpeak(id, text, rate, lang);
            if (ttsReady) job.run(); else ttsPending.add(job);
        });
    }

    @JavascriptInterface
    public void stopSpeaking() {
        main.post(() -> {
            ttsPending.clear();
            if (tts != null) {
                try { tts.stop(); } catch (Exception ignored) { }
            }
        });
    }

    @JavascriptInterface
    public void closeOverlay() {
        host.closeOverlay();
    }

    @JavascriptInterface
    public void openFull() {
        host.openFull();
    }

    // ---------------------------------------------------------------- speech recognition

    private void doStartListening(String lang) {
        destroyRecognizer();
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            emit("error", "service-not-allowed");
            return;
        }
        final SpeechRecognizer mine = SpeechRecognizer.createSpeechRecognizer(ctx);
        sr = mine;
        mine.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { if (mine == sr) emit("start", ""); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onPartialResults(Bundle partial) {
                if (mine != sr) return;
                String t = first(partial);
                if (!t.isEmpty()) emit("partial", t);
            }

            @Override
            public void onResults(Bundle results) {
                if (mine != sr) return;
                String t = first(results);
                destroyRecognizer();
                if (t.isEmpty()) emit("error", "no-speech"); else emit("final", t);
            }

            @Override
            public void onError(int error) {
                if (mine != sr) return;
                destroyRecognizer();
                emit("error", mapError(error));
            }
        });

        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        try {
            mine.startListening(i);
        } catch (Exception e) {
            destroyRecognizer();
            emit("error", "audio-capture");
        }
    }

    private static String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> l = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (l == null || l.isEmpty() || l.get(0) == null) ? "" : l.get(0);
    }

    private static String mapError(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "aborted";
            default:
                return "service-not-allowed";
        }
    }

    private void destroyRecognizer() {
        SpeechRecognizer old = sr;
        sr = null;
        if (old != null) {
            try { old.cancel(); } catch (Exception ignored) { }
            try { old.destroy(); } catch (Exception ignored) { }
        }
    }

    // ---------------------------------------------------------------- text to speech

    private void initTts() {
        tts = new TextToSpeech(ctx, status -> main.post(() -> {
            if (status != TextToSpeech.SUCCESS) return;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { }
                @Override public void onDone(String utteranceId) { emit("ttsdone", utteranceId); }
                @Override public void onError(String utteranceId) { emit("ttserror", utteranceId); }
            });
            ttsReady = true;
            List<Runnable> jobs = new ArrayList<>(ttsPending);
            ttsPending.clear();
            for (Runnable r : jobs) r.run();
        }));
    }

    private void doSpeak(String id, String text, float rate, String lang) {
        if (lang != null && !lang.isEmpty() && !lang.equals(ttsLang)) {
            try { tts.setLanguage(Locale.forLanguageTag(lang)); } catch (Exception ignored) { }
            ttsLang = lang;
        }
        tts.setSpeechRate(rate > 0 ? rate : 1f);
        int r = tts.speak(text, TextToSpeech.QUEUE_ADD, null, id);
        if (r != TextToSpeech.SUCCESS) emit("ttserror", id);
    }

    // ---------------------------------------------------------------- native -> JS

    private void emit(String type, String data) {
        final String js = "window.__nativeVoice&&window.__nativeVoice.event("
                + JSONObject.quote(type) + "," + JSONObject.quote(data == null ? "" : data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    public void shutdown() {
        main.post(() -> {
            destroyRecognizer();
            ttsPending.clear();
            if (tts != null) {
                try { tts.stop(); tts.shutdown(); } catch (Exception ignored) { }
                tts = null;
            }
        });
    }
}
