扫二维码（iPhone ↔ iPad 传拼豆板和进度用）：[zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.1.4 的只读版（MIT，见 LICENSE-zxing-wasm），核心是 [ZXing-C++](https://github.com/zxing-cpp/zxing-cpp)（Apache-2.0，见 LICENSE-zxing-cpp）。

- `zxing-reader.mjs`：用 esbuild 从 npm 包 `zxing-wasm/reader` 打包成 ES 模块，没有改动代码
- `zxing_reader.wasm`：npm 包里的原文件（约 0.9 MB），第一次扫码时才下载，之后留在手机/iPad 上

比 jsQR 抗噪声、抗反光好得多（模拟摄像头拍屏幕：jsQR 基本读不出，ZXing 大部分能读），每帧 10 ms 左右。
