PP-OCRv5 mobile 文字识别模型（PaddleOCR，Apache-2.0，见 LICENSE）。

rec.onnx 由官方 PP-OCRv5_mobile_rec 导出的 ONNX 精简而来：只保留了输出层里拼豆清单用得到的 96 个字符
（ASCII 可见字符 + × （ ））加 CTC 空白和空格，其余网络结构和权重不变，所以这些字符的识别结果与原模型完全相同，
文件从 16.5 MB 缩到 7.7 MB。dict.txt 是对应的字表（顺序与输出层一致）。
