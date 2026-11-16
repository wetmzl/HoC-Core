package io.github.wetmzl.blackjack;
import android.content.Context;
import java.io.File;
final class CoreUpdateTestState {
    static void remove(File file) {
        File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child);
        file.delete();
    }
    static void reset(Context context) {
        context.getSharedPreferences("core-updates", 0).edit().clear().commit();
        remove(new File(context.getCacheDir(), "core-updates"));
        remove(new File(context.getFilesDir(), "core-update-parts"));
        remove(new File(context.getFilesDir(), "core-update-identities"));
    }
}
