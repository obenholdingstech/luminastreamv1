# RVC Server Setup Guide — OpenVoiceChanger on GPU

This guide walks you through deploying a real-time RVC voice conversion server that our app connects to via WebSocket. Estimated setup time: 30–60 minutes.

---

## What We're Building

```
Browser (our app)  ──WebSocket──▶  GPU Server (OpenVoiceChanger)  ──▶  RVC inference  ──▶  converted audio back
   AudioWorklet                    FastAPI + WebSocket                   .pth model on GPU
   44.1kHz float32                 44.1kHz float32                      ~100ms round-trip
```

**Why this is better than ElevenLabs:**
- WebSocket persistent connection (no per-chunk HTTP overhead)
- RVC preserves emotion, prosody, and timing better than STS
- ~100ms round-trip vs ~300ms+ with cloud APIs
- You control the server — no rate limits, no per-request cost

---

## Step 1: Rent a GPU Server

### Option A: RunPod (Recommended — cheapest, easiest)

1. Go to [runpod.io](https://www.runpod.io) and create an account
2. Click **Deploy** → **Pods**
3. Select a GPU template:
   - **RTX 3090** (~$0.40/hr) — good for 1-2 concurrent users
   - **RTX 4090** (~$0.70/hr) — best for multiple concurrent users
4. Template: **PyTorch 2.1+ with CUDA** (any official PyTorch template works)
5. Deploy with at least **40GB disk** space (for models + dependencies)
6. Note the public IP and port — you'll need these later

### Option B: Any cloud GPU provider
Any provider works as long as you have:
- SSH access
- NVIDIA GPU with CUDA 11.8+
- Python 3.10+
- Public IP address (or domain) with an open port

---

## Step 2: SSH Into the Server

```bash
ssh root@<your-server-ip>
```

---

## Step 3: Clone OpenVoiceChanger

```bash
git clone https://github.com/sioaeko/OpenVoiceChanger.git
cd OpenVoiceChanger
```

---

## Step 4: Install Dependencies (GPU)

```bash
# Create virtual environment
python3.10 -m venv .venv
source .venv/bin/activate

# Upgrade pip
python -m pip install --upgrade pip

# Install backend dependencies
pip install -r backend/requirements.txt

# Install RVC engine
pip install --no-deps git+https://github.com/RVC-Project/Retrieval-based-Voice-Conversion

# Install PyTorch with CUDA 11.8 (if not already on the template)
pip install torch==2.1.1+cu118 torchaudio==2.1.1+cu118 --index-url https://download.pytorch.org/whl/cu118

# Optional: ONNX GPU acceleration
pip uninstall -y onnxruntime
pip install onnxruntime-gpu==1.23.2
```

**Verify GPU is detected:**
```bash
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'Device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"CPU only\"}')"
```

If you see `CUDA available: True`, you're ready. If not, check your NVIDIA drivers (`nvidia-smi`).

---

## Step 5: Download HuBERT Model (Required for RVC)

RVC models need the HuBERT content encoder:

```bash
mkdir -p models/assets
wget -O models/assets/hubert_base.pt https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/hubert_base.pt
```

Verify the file is ~379MB:
```bash
ls -lh models/assets/hubert_base.pt
```

---

## Step 6: Add Your RVC Voice Models

Place your `.pth` model files in the `models/` directory:

```bash
# Example: copy a model you already have
cp /path/to/your_voice.pth models/

# Or download a pre-trained model (example)
wget -O models/my_voice.pth https://example.com/model.pth
```

If you have a companion `.index` file, place it alongside the `.pth`:
```bash
cp /path/to/your_voice.index models/
```

**Note:** You can also upload models via the web UI after the server is running (drag-and-drop on the Models tab).

---

## Step 7: Start the Server

```bash
# Set environment variables for production
export OVC_HOST=0.0.0.0
export OVC_PORT=8000
export OVC_CORS_ORIGINS='["*"]'
export OVC_SAMPLE_RATE=44100

# Start the server
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

**Verify it's running:**
```bash
curl http://localhost:8000/health
# Should return: {"status": "healthy"}
```

---

## Step 8: Open the Port for External Access

### On RunPod:
- Go to your pod settings
- Add a public port mapping for port **8000** (HTTP)
- Note the public URL (e.g., `https://abc123-8000.proxy.runpod.net`)

### On other providers:
- Open port 8000 in your firewall/security group
- Use the server's public IP (e.g., `http://203.0.113.50:8000`)

**Test from your local machine:**
```bash
curl https://<your-public-url>/health
# Should return: {"status": "healthy"}
```

---

## Step 9: Set the Server URL in Your App

In your Base44 app dashboard:
1. Go to **Settings** → **Environment Variables**
2. Add a new secret:
   - Name: `RVC_SERVER_URL`
   - Value: `wss://<your-public-url>/ws/audio`
   - (Use `wss://` if your server has HTTPS, `ws://` if HTTP)

**Examples:**
- RunPod with HTTPS: `wss://abc123-8000.proxy.runpod.net/ws/audio`
- Direct IP with HTTP: `ws://203.0.113.50:8000/ws/audio`

Once this secret is set, the app will automatically use the RVC server instead of ElevenLabs.

---

## Step 10: Activate a Voice Model

Before streaming, activate a model on the server:

**Via API:**
```bash
# List available models
curl https://<your-public-url>/api/models/

# Activate a model
curl -X POST https://<your-public-url>/api/models/your_voice.pth/activate
```

**Via Web UI:**
Open `https://<your-public-url>` in your browser, go to the **Models** tab, and click activate on your model.

---

## Keeping the Server Running

### Option A: tmux (simple)
```bash
tmux new -s ovc
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
# Press Ctrl+B, then D to detach
# tmux attach -t ovc to reconnect
```

### Option B: systemd (auto-restart on crash)
```bash
cat > /etc/systemd/system/ovc.service << 'EOF'
[Unit]
Description=OpenVoiceChanger Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/OpenVoiceChanger
Environment=OVC_HOST=0.0.0.0
Environment=OVC_PORT=8000
Environment=OVC_CORS_ORIGINS=["*"]
Environment=OVC_SAMPLE_RATE=44100
ExecStart=/root/OpenVoiceChanger/.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ovc
systemctl start ovc
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `CUDA available: False` | Run `nvidia-smi`. If it works, reinstall PyTorch with the correct CUDA version. |
| WebSocket connection fails | Check that port 8000 is open. Try `curl https://<url>/health` from your machine. |
| Audio sounds garbled | Ensure `OVC_SAMPLE_RATE=44100` matches what the client sends. |
| Model won't load | Ensure `hubert_base.pt` is in `models/assets/`. Check server logs. |
| High latency | Try a smaller `chunk_size` (e.g., 2048). Ensure you're using GPU not CPU. |

---

## Cost Estimation

- **RTX 3090 on RunPod:** ~$0.40/hour = ~$290/month (24/7)
- **RTX 4090 on RunPod:** ~$0.70/hour = ~$510/month (24/7)
- **Spot instances:** 50-70% cheaper (but can be interrupted)

For a studio that's used a few hours per day, a spot instance is the most cost-effective option.

---

Once your server is running and `RVC_SERVER_URL` is set, tell me and I'll help you test the connection and fine-tune the latency.