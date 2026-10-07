FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
# ffmpeg：算音柱数据时把各种格式的音频解成采样；贴网址搬来的音频转成 mp3
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY harvest ./harvest

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
