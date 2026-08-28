# 這些模型你被允許拿來做什麼

沒有人把這件事整理起來，而它決定你的專案是興趣還是生意。下面每一列都對照過該專案自己的 LICENSE 檔案、README 與模型卡，附上連結。

> **這不是法律意見。** 這是一份閱讀清單加上我們的讀法。授權會改、模型卡會被編輯、你的司法管轄區跟我們不同。在向任何人收錢之前，請自己打開連結讀過。

> ⚠️ **這一頁第一個公開版本錯得很嚴重，而那個更正是這頁上最有用的東西。** 我們推薦了一條「乾淨的商用路線」，建立在一個我們沒有稽核過的模型上，而稽核方法正是這一頁自己教你的那套。一次對抗式審查抓到了它。我們錯在哪裡寫在最下面，因為**那個失敗模式比結論更有教育意義**。

---

## 兩件會抓到人的事

**1. 程式碼與權重經常授權不同。** 寫著「MIT」或「Apache-2.0」的徽章描述的是**程式碼**。訓練好的模型是另一個產物，通常訓練在一份有自己條款的資料集上。

**2. 最上層的寬鬆授權，對執行時載入什麼隻字未提。** 這一條就是抓到我們的那一條。一個專案可以真的是 Apache-2.0，同時在**必經的推論路徑上**挾帶並非如此的第三方模型檔案。

第二條比較難看見，因為**沒有東西可讀**——那個限制住在一個你沒打開過的儲存庫裡，被一個專案毫無說明地打包進去的檔案引用著。

---

## 對嘴：4 個裡有 3 個帶著非商業限制

| 專案 | 程式碼 | 權重 | 執行期依賴 | 可商用？ |
|---|---|---|---|---|
| [Wav2Lip](https://github.com/Rudrabha/Wav2Lip) | **整個 repo 受限** | 僅限研究／學術／個人 | - | ❌ **不行** |
| [LatentSync](https://github.com/bytedance/LatentSync) | Apache-2.0 | openrail++（只有標籤） | **InsightFace** | ❌ **照原樣不行** |
| [Ditto](https://github.com/antgroup/ditto-talkinghead) | Apache-2.0 | Apache-2.0 | **InsightFace** | ❌ **照原樣不行** |
| [MuseTalk](https://github.com/TMElyralab/MuseTalk) | MIT | 「任何用途，包括商業」 | S3FD 條款未載明 | ⚠️ 最接近，還差一個 |

### Wav2Lip：受限的是整個 repo，不只是權重

[README 的 License and Citation 段落](https://github.com/Rudrabha/Wav2Lip#license-and-citation)：

> 「This repository can only be used for personal/research/non-commercial purposes.」

以及開源那一半上方的免責聲明：

> 「As the models are trained on the LRS2 dataset, any form of commercial use is strictly prohibited.」

**沒有 LICENSE 檔案。** 開源版本上方的標題直接寫著「Non Commercial Open-source Version」。所以你連程式碼都不能商業分支——限制比權重限制更廣。

商用權重由 Sync Labs 以付費 API 另外販售。

這件事很要緊，因為 Wav2Lip 同時也是顯存最省的選項。**「用 8 GB 跑得動」和「做一個產品」指向不同的模型。**

### LatentSync 與 Ditto：上面是 Apache-2.0，底下是 InsightFace

兩者在每一次推論都載入 [InsightFace](https://github.com/deepinsight/insightface) 的偵測模型。InsightFace 自己的條款：

> 「The training data containing the annotation (and the models trained with these data) are available for **non-commercial research purposes only**.」
> 「Both manual-downloading models from our github repo and auto-downloading models with our python-library follow the above license policy.」

**Ditto**，在一份已安裝的副本上查證：

```
checkpoints/ditto_pytorch/aux_models/det_10g.onnx      16.9 MB   InsightFace buffalo_l
checkpoints/ditto_pytorch/aux_models/2d106det.onnx      5.0 MB   InsightFace 106 點

core/atomic_components/source2info.py:4    from ..aux_models.insightface_det import InsightFaceDet
core/atomic_components/source2info.py:59   self.insightface_det = InsightFaceDet(...)
core/atomic_components/source2info.py:71   det, _ = self.insightface_det(img)
```

頂層 import、在 `__init__` 裡建構、每次推論都呼叫。**沒有接上任何替代的偵測器。** 那些模型被打包在一個帶著 Apache-2.0 LICENSE 的權重儲存庫裡，而 Ant Group 並不處在能對它們授予這個授權的位置。

**LatentSync**，同樣的模式，同樣在已安裝的副本上查證：

```
requirements.txt:24                       insightface==0.7.3
latentsync/utils/face_detector.py:1       from insightface.app import FaceAnalysis
```

`FaceAnalysis` 會自動下載 buffalo_l，正好落在上面那條「auto-downloading models」的條款裡。

⚠️ **兩個專案都沒有提到這件事。** 而 Ditto 的 README 致謝為基礎的 [LivePortrait](https://github.com/KwaiVGI/LivePortrait/blob/main/LICENSE)，在自己的 LICENSE 檔案裡確實帶著這個警告，而且告訴你該怎麼辦：

> 「If you want to use the LivePortrait project for commercial purposes, you should **remove and replace InsightFace's detection models** to fully comply with the MIT license.」

那就是兩者的解方：**換掉偵測器。** 對嘴模型本身不是問題。

⚠️ LatentSync 的權重在模型卡上帶著 `openrail++` 標籤，但 Hugging Face 儲存庫裡**沒有 LICENSE 檔案**——所以那個授權附加的使用限制，在來源處讀不到。

### MuseTalk：唯一一個公開自己依賴鏈的

MuseTalk 自己的條款是這裡最寬鬆的——MIT 程式碼，以及：

> 「`model`: The trained model are available for any purpose, even commercially.」

而且它**列舉**自己的第三方元件而不是藏起來。它的 LICENSE 列了 sd-vae-ft-mse（MIT）、whisper（MIT）、face-parsing.PyTorch（MIT）、DWPose（Apache-2.0）、face-alignment（BSD 3-Clause）。

⚠️ **還差一個：** S3FD 那一條給了儲存庫網址然後就停了——**沒有載明任何授權**。我們把它標出來，而不是假設它沒問題。

⚠️ README 裡一句容易漏掉的話：「The testdata are collected from internet, which are available for non-commercial research purposes only.」那涵蓋的是範例資料，不是模型。

## 語言模型與語音：乾淨

| 專案 | 授權 | 可商用？ |
|---|---|---|
| [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) | Apache-2.0 | ✅ 可以 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE) | Apache-2.0 | ✅ 可以 |

程式碼與權重都是 Apache-2.0，模型卡上沒有附加條款。Qwen3-TTS 的各個權重儲存庫都個別標記為 `apache-2.0`。這是整套堆疊裡不複雜的那一塊。

## GFPGAN：不是 Apache-2.0，也不是「未解」

| 專案 | 實際情況 |
|---|---|
| [GFPGAN](https://github.com/TencentARC/GFPGAN/blob/master/LICENSE) | Apache-2.0 **除了**列舉出來的第三方元件 | ❌ **不行** |

它的 LICENSE 開頭就寫：

> 「GFPGAN is licensed under the Apache License Version 2.0 **except for the third-party components listed below**.」

而那些元件裡包括：

- **StyleGAN2**，NVIDIA 授權：「The Work and any derivative works thereof only may be used or intended for use **non-commercially**.」
- **DFDNet**，Creative Commons Attribution-**NonCommercial**-ShareAlike 4.0

所以一個用了 GFPGAN 的臉部修復步驟，在商業上不乾淨。GitHub 把這個儲存庫分類為「Other」，不是 Apache-2.0。

---

## 那你到底能出貨什麼？

**誠實的答案：我們沒有一條完整查證過的商用對嘴路線可以推薦，而我們不打算再編一次。**

我們能說的是：

```
LLM        Qwen3         Apache-2.0，查證乾淨
TTS        Qwen3-TTS     Apache-2.0，查證乾淨
增強       不要用 GFPGAN  它的 LICENSE 裡有 NVIDIA 與 CC-BY-NC 元件
對嘴       ← 未解的問題
```

對嘴有兩條可能可行的路，兩條我們都還沒走完：

1. **MuseTalk**，如果你把 S3FD 的條款釐清。它自己的授權是寬鬆的，而且它公開自己的依賴鏈——那正是你希望上游有的行為。
2. **Ditto 或 LatentSync，把 InsightFace 偵測器換掉**，正如 LivePortrait 的 LICENSE 所指示。對嘴權重沒問題，**臉部偵測器才是問題**，而臉部偵測有寬鬆授權的替代品。

如果你走完其中一條，你就做了我們沒做的功課。**我們寧可這樣說，也不要再遞給你一個很有自信的推薦。**

⚠️ 不管你挑哪一個，`00-hardware.zh-TW.md` 與 `04-latency.zh-TW.md` 裡的效能數字都是在一個 Wav2Lip 這一類的服務上量的。**它們不會自動變成你那個模型的數字。** 拿 `bench/` 對你真正要出貨的東西重跑一次。

---

## 怎麼自己查

授權會變，而**程序比上面那張表更重要**：

1. 打開專案的 **LICENSE 檔案**，不是徽章。GFPGAN 的徽章說 Apache-2.0，而它的 LICENSE 檔案切出了兩個非商業元件。
2. 打開權重的**模型卡**——通常是另一個 Hugging Face 頁面，有自己的授權欄位。並且確認它宣稱的那個授權**有沒有真的附上條文**；LatentSync 的沒有。
3. 讀 README 的**免責聲明**段落。權重的非商業限制寫在那裡的機率，遠高於寫在 LICENSE 檔案裡。
4. **列出這個專案在執行時 import 與載入了什麼，對每一個重複以上步驟。** 對推論路徑 `grep` 模型載入，並看看權重儲存庫裡實際打包了哪些檔案。**這是所有人都會跳過的一步。**

如果一個專案對某個被打包進去的第三方模型什麼都沒說，那是一個**發現**，不是一個許可。

---

## 我們錯在哪裡，以及為什麼

這一頁的第一版推薦了 **「Ditto ＋ Qwen3 ＋ Qwen3-TTS，全部 Apache-2.0，沒有依賴鏈要稽核。」**

那句話裡每一個部分都查過了，除了最要緊的那個部分。我們讀了 Ditto 的 LICENSE（Apache-2.0 ✓）、看了它的模型卡（沒有另訂條款 ✓），然後斷定它是乾淨的——**卻沒有對它做第 4 步**。我們對 MuseTalk 做了第 4 步，而它是那個公開自己依賴的專案，然後我們把它標成有風險的那一個。

**那把真正的風險顛倒過來了。公開自己依賴鏈的專案，才是好評估的那一個；什麼都不說的那個，才是你必須去翻的。** 我們用懷疑回報了揭露，用一個綠勾回報了沉默。

我們也把 GFPGAN 標成「未解，我們不猜」——那讀起來像是嚴謹，實際上是沒有打開一個在第一句話就回答了這個問題的檔案。

**這兩個錯誤在這一頁發布的當天都找得到。這不是授權漂移，是一次在它正要推薦的那一列上提早停止的稽核。**
