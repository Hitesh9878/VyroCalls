// Turns a picked photo into a small square JPEG data URL (centre-cropped) for use as an avatar.
// The server only accepts about 30 KB, so the quality steps down until it fits.
export async function fileToAvatar(file, size = 128) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image. Try a JPEG or PNG.'));
      el.src = url;
    });

    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // transparent PNGs would turn black in a JPEG
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

    for (const quality of [0.85, 0.75, 0.6, 0.45]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length <= 28000) return data;
    }
    throw new Error('That image is too detailed. Please try a different one.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
