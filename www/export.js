/* SRK Reach — save what you're reading as Word (.docx), PDF or text.
 * DOCX is built here by hand (no library); PDF uses jsPDF (www/vendor/jspdf.umd.min.js).
 * Text is large and dark for easy reading and printing.
 */
(function () {
  "use strict";

  // ---------- shared ----------
  function safeName(title) {
    const n = String(title || "SRK Reach").replace(/[\\/:*?"<>|#%\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70).trim();
    return n || "SRK Reach";
  }
  const plainMd = (s) => String(s || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/^#{1,4}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "• ");
  const isHeading = (l) => /^[A-Z][A-Z &]{3,30}$/.test(l.trim());
  const isRule = (l) => /^[—\-–\s]{3,}$/.test(l.trim());

  // Builds the list of blocks every format prints: {kind: title|meta|h|p, text}
  function blocks(doc) {
    const out = [{ kind: "title", text: doc.title || "Untitled" }];
    const meta = [doc.author, doc.date, doc.meta].filter(Boolean).join("  ·  ");
    if (meta) out.push({ kind: "meta", text: meta });
    if (doc.url) out.push({ kind: "meta", text: doc.url });
    out.push({ kind: "meta", text: "Saved from SRK Reach on " + new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) });
    for (const s of doc.summaries || []) {
      out.push({ kind: "h", text: s.label });
      for (const l of plainMd(s.text).split("\n")) if (l.trim()) out.push({ kind: "p", text: l.trim() });
    }
    let first = true;
    for (const l of String(doc.text || "").split("\n")) {
      if (!l.trim() || isRule(l)) continue;
      if (isHeading(l)) { out.push({ kind: "h", text: l.trim().charAt(0) + l.trim().slice(1).toLowerCase() }); first = false; continue; }
      if (first && (doc.summaries || []).length) { out.push({ kind: "h", text: "Full text" }); }
      first = false;
      out.push({ kind: "p", text: l.trim() });
    }
    return out;
  }

  // ---------- tiny ZIP writer (stored, no compression) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const [name, content] of files) {
      const nb = enc.encode(name), data = enc.encode(content), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), nb);
      offset += 30 + nb.length + data.length;
    }
    const csize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  // ---------- DOCX ----------
  const x = (s) => String(s).replace(/[^\x09\x0A\x0D\x20-퟿-�]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function para(b) {
    const style = { title: "Title", h: "Heading1", meta: "Meta" }[b.kind];
    const ppr = style ? "<w:pPr><w:pStyle w:val=\"" + style + "\"/></w:pPr>" : "";
    return "<w:p>" + ppr + "<w:r><w:t xml:space=\"preserve\">" + x(b.text) + "</w:t></w:r></w:p>";
  }
  function toDocx(doc) {
    const body = blocks(doc).map(para).join("");
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const files = [
      ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'],
      ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'],
      ["docProps/core.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + x(doc.title || "") + '</dc:title><dc:creator>SRK Reach</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().slice(0, 19) + "Z</dcterms:created></cp:coreProperties>"],
      ["word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["word/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + W + '>' +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Nirmala UI" w:eastAsia="Calibri"/><w:color w:val="000000"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="0B4F4A"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:color w:val="333333"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
        "</w:styles>"],
      ["word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + W + "><w:body>" + body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>'],
    ];
    return zip(files);
  }

  // ---------- PDF ----------
  function latin(s) {
    return String(s).replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[—–−]/g, "-").replace(/•/g, "-").replace(/…/g, "...")
      .replace(/ /g, " ").replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "");
  }
  function toPdf(doc) {
    const J = window.jspdf && window.jspdf.jsPDF;
    if (!J) throw new Error("PDF maker didn't load — save as Word instead.");
    const pdf = new J({ unit: "mm", format: "a4" });
    const M = 18, W = 210 - 2 * M, BOTTOM = 297 - 18;
    let y = M;
    const LH = { title: 9.5, h: 8, meta: 5.6, p: 6.4 };
    const SZ = { title: 21, h: 16, meta: 11, p: 13 };
    for (const b of blocks(doc)) {
      pdf.setFont("helvetica", b.kind === "title" || b.kind === "h" ? "bold" : "normal");
      pdf.setFontSize(SZ[b.kind]);
      pdf.setTextColor(b.kind === "h" ? 11 : b.kind === "meta" ? 51 : 0, b.kind === "h" ? 79 : b.kind === "meta" ? 51 : 0, b.kind === "h" ? 74 : b.kind === "meta" ? 51 : 0);
      const lines = pdf.splitTextToSize(latin(b.text), W);
      if (b.kind === "h") y += 4;
      if (b.kind === "h" && y + LH.h * 2 > BOTTOM) { pdf.addPage(); y = M; }
      for (const ln of lines) {
        if (y + LH[b.kind] > BOTTOM) { pdf.addPage(); y = M; }
        y += LH[b.kind] * 0.8;
        pdf.text(ln, M, y);
        y += LH[b.kind] * 0.2;
      }
      y += b.kind === "p" ? 2.4 : b.kind === "meta" ? 0.6 : 2;
    }
    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      pdf.setPage(i); pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(80, 80, 80);
      pdf.text("SRK Reach  ·  " + i + " / " + n, 105, 297 - 8, { align: "center" });
    }
    return new Uint8Array(pdf.output("arraybuffer"));
  }
  const nonLatinShare = (doc) => { const s = (doc.title || "") + (doc.text || "").slice(0, 5000); const bad = (s.match(/[^\x00-\xFF‘’“”—–•…]/g) || []).length; return bad / Math.max(1, s.length); };

  // ---------- TXT ----------
  function toTxt(doc) {
    const t = blocks(doc).map((b) => (b.kind === "title" ? b.text.toUpperCase() + "\n" : b.kind === "h" ? "\n" + b.text.toUpperCase() + "\n" : b.text)).join("\n");
    return new TextEncoder().encode(t + "\n");
  }

  const FORMATS = {
    docx: { label: "Word (.docx)", ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", make: toDocx },
    pdf: { label: "PDF", ext: "pdf", mime: "application/pdf", make: toPdf },
    txt: { label: "Text (.txt)", ext: "txt", mime: "text/plain", make: toTxt },
  };

  function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  window.SRKExport = { FORMATS, safeName, b64, nonLatinShare, blocks };
})();
