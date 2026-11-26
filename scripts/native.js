// Adds SRK Reach's own native code (the "save to folder" plugin) to the generated Android project.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const pkgDir = path.join(root, "android", "app", "src", "main", "java", "com", "shazverse", "srkreach");
fs.mkdirSync(pkgDir, { recursive: true });
fs.copyFileSync(path.join(root, "native", "SrkSavePlugin.java"), path.join(pkgDir, "SrkSavePlugin.java"));
fs.writeFileSync(path.join(pkgDir, "MainActivity.java"), `package com.shazverse.srkreach;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SrkSavePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
console.log("Native save plugin added in", pkgDir);
