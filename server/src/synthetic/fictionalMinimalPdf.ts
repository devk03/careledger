/** Generated fictional one-page PDF. Never derived from a patient record. */
export function fictionalMinimalPdf(): Buffer {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  const add = (id: number, value: string) => {
    offsets[id] = Buffer.byteLength(body, "ascii");
    body += `${id} 0 obj\n${value}\nendobj\n`;
  };
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>");
  add(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>");
  add(4, "<< /Length 0 >>\nstream\n\nendstream");
  const xref = Buffer.byteLength(body, "ascii");
  body += "xref\n0 5\n0000000000 65535 f \n";
  for (let id = 1; id <= 4; id += 1)
    body += `${offsets[id]!.toString().padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
