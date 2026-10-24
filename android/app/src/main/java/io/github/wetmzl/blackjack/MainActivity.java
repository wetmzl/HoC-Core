package io.github.wetmzl.blackjack;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HocHapticsPlugin.class);
        registerPlugin(ContentIoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
