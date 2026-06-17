FROM node:20-slim

# Installer ffmpeg, python3/pip (pour yt-dlp), et dépendances Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    wget \
    curl \
    unzip \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Installer yt-dlp via pip (toujours à jour)
RUN pip3 install --break-system-packages -U yt-dlp

# Installer Deno (runtime JS requis par yt-dlp pour contourner les protections YouTube)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Permettre à Puppeteer d'utiliser le Chromium téléchargé automatiquement
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

COPY . .

RUN mkdir -p tmp logs

EXPOSE 4000

CMD ["node", "src/index.js"]
