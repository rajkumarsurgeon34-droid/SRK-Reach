package com.shazverse.srkreach;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/** SRK Reach: save files into a folder the user picked once (Android Storage Access Framework). */
@CapacitorPlugin(name = "SrkSave")
public class SrkSavePlugin extends Plugin {

    private static final int RW = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    /** Let the user choose a save folder; the permission is kept across restarts. */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(RW | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled", "CANCELLED");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, RW);
        } catch (Exception ignored) { }
        JSObject o = new JSObject();
        o.put("uri", tree.toString());
        o.put("name", folderName(tree));
        call.resolve(o);
    }

    /** Write a file straight into the chosen folder (no prompt). Duplicate names get " (1)". */
    @PluginMethod
    public void saveToFolder(PluginCall call) {
        String folder = call.getString("folder");
        String name = call.getString("fileName", "SRK Reach");
        String mime = call.getString("mimeType", "application/octet-stream");
        String data = call.getString("data", "");
        try {
            Uri tree = Uri.parse(folder);
            ContentResolver cr = getContext().getContentResolver();
            Uri dir = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            Uri doc = DocumentsContract.createDocument(cr, dir, mime, name);
            if (doc == null) throw new Exception("Android couldn't create the file in that folder.");
            write(doc, data);
            JSObject o = new JSObject();
            o.put("uri", doc.toString());
            o.put("folder", folderName(tree));
            call.resolve(o);
        } catch (SecurityException e) {
            call.reject("The app lost permission for the save folder — choose it again.", "NO_PERMISSION");
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Couldn't save the file." : e.getMessage(), "SAVE_FAILED");
        }
    }

    /** Ask where to save this one file (Android "Save as" screen). */
    @PluginMethod
    public void saveAs(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(call.getString("mimeType", "application/octet-stream"));
        i.putExtra(Intent.EXTRA_TITLE, call.getString("fileName", "SRK Reach"));
        startActivityForResult(call, i, "saveAsPicked");
    }

    @ActivityCallback
    private void saveAsPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled", "CANCELLED");
            return;
        }
        Uri doc = result.getData().getData();
        try {
            write(doc, call.getString("data", ""));
            JSObject o = new JSObject();
            o.put("uri", doc.toString());
            call.resolve(o);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Couldn't save the file." : e.getMessage(), "SAVE_FAILED");
        }
    }

    /** Open a saved file in Word, a PDF viewer, etc. */
    @PluginMethod
    public void open(PluginCall call) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(call.getString("uri")), call.getString("mimeType", "*/*"));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(Intent.createChooser(i, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this phone can open that file.", "NO_APP");
        }
    }

    private void write(Uri doc, String base64) throws Exception {
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        try (OutputStream os = getContext().getContentResolver().openOutputStream(doc, "wt")) {
            if (os == null) throw new Exception("Couldn't open the file for writing.");
            os.write(bytes);
        }
    }

    private static String folderName(Uri tree) {
        try {
            String id = DocumentsContract.getTreeDocumentId(tree); // e.g. "primary:Documents/SRK"
            int c = id.indexOf(':');
            String vol = c > 0 ? id.substring(0, c) : "";
            String path = c >= 0 ? id.substring(c + 1) : id;
            String root = "primary".equals(vol) ? "Phone" : (vol.isEmpty() ? "" : "SD card");
            return path.isEmpty() ? (root.isEmpty() ? "Chosen folder" : root) : path;
        } catch (Exception e) {
            return "Chosen folder";
        }
    }
}
