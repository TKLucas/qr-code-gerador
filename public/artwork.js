(function attachArtwork(globalScope) {
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Não foi possível carregar a imagem da arte.'));
      image.src = src;
    });
  }

  async function renderArtwork(canvas, { baseArtUrl, qrImageUrl, qrSlot }) {
    const context = canvas.getContext('2d');
    const [baseArtImage, qrImage] = await Promise.all([
      loadImage(baseArtUrl),
      loadImage(qrImageUrl),
    ]);

    canvas.width = baseArtImage.naturalWidth;
    canvas.height = baseArtImage.naturalHeight;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(baseArtImage, 0, 0, canvas.width, canvas.height);

    const slot = qrSlot || { x: 0.303, y: 0.635, size: 0.404, padding: 0.021 };
    const qrSlotX = canvas.width * slot.x;
    const qrSlotY = canvas.height * slot.y;
    const qrSlotSize = canvas.width * slot.size;
    const qrPadding = canvas.width * slot.padding;
    const qrX = qrSlotX + qrPadding;
    const qrY = qrSlotY + qrPadding;
    const qrSize = qrSlotSize - (qrPadding * 2);

    context.imageSmoothingEnabled = false;
    context.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
    context.imageSmoothingEnabled = true;
  }

  globalScope.artwork = {
    renderArtwork,
  };
})(window);
