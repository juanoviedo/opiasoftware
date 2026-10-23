# Whisper local para transcribir las notas de voz de WhatsApp: sin claves ni
# costo por minuto. El modelo (base cuantizado, ~57 MB) queda dentro de la imagen.
FROM node:22-alpine AS whisper
RUN apk add --no-cache git cmake make g++ linux-headers
WORKDIR /whisper
RUN git clone --depth 1 --branch v1.7.6 https://github.com/ggerganov/whisper.cpp . \
  && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  && cmake --build build --target whisper-cli -j4
ADD https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin /whisper/ggml-base-q5_1.bin

FROM node:22-alpine
RUN apk add --no-cache ffmpeg libstdc++ libgomp
WORKDIR /app
COPY --from=whisper /whisper/build/bin/whisper-cli /app/stt/whisper-cli
COPY --from=whisper /whisper/ggml-base-q5_1.bin /app/stt/ggml-base-q5_1.bin
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
