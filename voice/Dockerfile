# syntax=docker/dockerfile:1
# english-coach voice gateway (FastAPI, :8100) —— compose 里 context 为 ../voice
#
# 本机（无 ffmpeg、无 GPU、无密钥）可直接运行：
#   docker build -t english-coach-voice ./voice
#   docker run --rm -p 8100:8100 -v voice-models:/models -v "$PWD/data:/data" english-coach-voice
# 默认 PROVIDER_MODE=mock：**没有任何密钥也能起来并全链路可用**。
FROM python:3.11-slim

# Python 包镜像源：国内/离线环境建议
#   --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
# （同时作用于下面的 pip 与 uv；compose 里通过 .env 的 PIP_INDEX_URL 传入）
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    UV_INDEX_URL=${PIP_INDEX_URL}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PROVIDER_MODE=mock \
    VOICE_HOST=0.0.0.0 \
    VOICE_PORT=8100 \
    DATA_DIR=/data \
    MODEL_CACHE_DIR=/models

# 依赖说明（已核对 PyPI 上的 cp311 manylinux wheel，slim 镜像无需编译器、无需系统 ffmpeg）：
#   av-18.1.0-cp311-abi3-manylinux_2_28_x86_64.whl                      <- PyAV wheel 自带 FFmpeg 库
#   praat_parselmouth-0.4.7-cp311-cp311-manylinux2014_x86_64...whl      <- 语调 F0 提取
#   numpy-2.4.6-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
# 因此**不装** ffmpeg/apt 依赖。若将来某架构（如 armv7）缺 wheel 导致源码编译失败，再解注释下面一行：
# RUN apt-get update && apt-get install -y --no-install-recommends \
#       libavformat-dev libavcodec-dev libavdevice-dev libavutil-dev libswscale-dev libswresample-dev \
#     && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "uv==0.8.12"

WORKDIR /app

# 先依赖后源码，最大化利用 Docker 层缓存
# （等价写法：RUN pip install --no-cache-dir -r requirements.txt）
COPY pyproject.toml uv.lock requirements.txt ./
RUN uv pip install --system --no-cache -r requirements.txt

COPY app ./app

# 同 web：构建上下文的文件可能是 600（umask 077 / scp 保留权限），
# 统一成"任何用户可读"，避免以后改成非 root 运行时出现 EACCES。
RUN chmod -R a+rX /app/app

# 预热 CLI 也进镜像：scripts/warmup.py 用 Path(__file__).parent.parent 推导 import 根，
# 放在 /app/scripts 下正好解析到 /app，因此容器内可直接
#   docker compose exec voice python scripts/warmup.py --items ...
# 不 COPY 的话容器里跑不了预热，只能走 HTTP 端点（deploy-docs 在 deployment.md 里发现的缺口）。
COPY scripts ./scripts

# DATA_DIR / MODEL_CACHE_DIR 允许挂 volume；代码本身也会 mkdir 兜底
RUN mkdir -p /data/audio /models

EXPOSE 8100

# slim 镜像没有 curl，用 python 做 healthcheck（/v1/health 无鉴权）
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/v1/health', timeout=3).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
