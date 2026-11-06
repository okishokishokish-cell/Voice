package com.bean.voice;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;

/** Settings for the always-listening wake phrase. */
final class Wake {
    private Wake() { }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("wake", Context.MODE_PRIVATE);
    }

    static File file(Context c) {
        return new File(c.getFilesDir(), "wake.ppn");
    }

    static boolean trained(Context c) {
        return file(c).exists();
    }

    static boolean ready(Context c) {
        SharedPreferences p = prefs(c);
        return p.getBoolean("enabled", false) && !p.getString("key", "").isEmpty() && trained(c);
    }
}
