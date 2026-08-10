"""
Generate voiceover audio with WORD-LEVEL timestamps using edge-tts.
Usage: python tts_word_sync.py "text" output.mp3 output_words.json [voice] [rate]
"""
import asyncio
import json
import sys
import edge_tts

async def generate(text, audio_path, words_path, voice="en-US-AndrewNeural", rate="+10%"):
    # KEY: boundary='WordBoundary' gives per-word timing events
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    
    words = []
    
    with open(audio_path, "wb") as audio_file:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_file.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({
                    "word": chunk["text"],
                    "start": chunk["offset"] / 10_000_000,  # 100ns ticks → seconds
                    "end": (chunk["offset"] + chunk["duration"]) / 10_000_000,
                })
    
    with open(words_path, "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False)
    
    # Print result for debugging
    print(json.dumps({"ok": True, "word_count": len(words)}))

if __name__ == "__main__":
    text = sys.argv[1]
    audio_path = sys.argv[2]
    words_path = sys.argv[3]
    voice = sys.argv[4] if len(sys.argv) > 4 else "en-US-AndrewNeural"
    rate = sys.argv[5] if len(sys.argv) > 5 else "+10%"
    
    # If --from-file flag is present, read text from the file path in argv[1]
    if "--from-file" in sys.argv:
        with open(text, "r", encoding="utf-8") as f:
            text = f.read().strip()
    
    asyncio.run(generate(text, audio_path, words_path, voice, rate))
