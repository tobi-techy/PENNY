import json, hashlib, base64, os
out='packages/shared/test-vectors'
def h(s): return base64.urlsafe_b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode().rstrip('=')
V=[
 ("01-rfc8785-primitives","RFC 8785 section 3.2.2 sample: numbers, string escapes, literals",
  r'{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA\u0027\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}',
  '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'),
 ("02-rfc8785-key-sorting","RFC 8785 section 3.2.3: keys sorted by UTF-16 code units (emoji surrogates sort before U+FB33)",
  r'{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}',
  '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}'),
 ("03-nested","Nested objects and arrays, empty containers, whitespace removed, array order kept",
  '{ "b": [ 3, {"z": {}, "a": []}, [ [ ] ] ], "a": { "y": { "x": { "w": null } }, "c": true } }',
  '{"a":{"c":true,"y":{"x":{"w":null}}},"b":[3,{"a":[],"z":{}},[[]]]}'),
 ("04-numbers","ECMAScript number serialization: -0 -> 0, exponent thresholds, max safe integer",
  '[0,-0,1,-1,1.5,1e21,1e20,1e-7,0.000001,0.1,100,9007199254740991,-12.250]',
  '[0,0,1,-1,1.5,1e+21,100000000000000000000,1e-7,0.000001,0.1,100,9007199254740991,-12.25]'),
 ("05-unicode","Unicode passes through unescaped, control chars use lowercase \\u escapes",
  r'{"name":"Tobi \ud83d\ude42","city":"Lagos","caf\u00e9":"na\u00efve","\u0000ctl":"\u001f\t","quote":"\"\\"}',
  '{"\\u0000ctl":"\\u001f\\t","café":"naïve","city":"Lagos","name":"Tobi 🙂","quote":"\\"\\\\"}'),
 ("06-plan-hash-invest","planHash input for an invest plan: {plan, actions}",
  json.dumps({"plan":{"kind":"invest","fromAsset":"USDC","amountUsd":"50","portfolioId":"eth-momentum","quoteId":"q_123"},"actions":[{"type":"FunctionCall","methodName":"ft_transfer_call","args":{"receiver_id":"intents.near","amount":"50000000","msg":"{\"deposit\":\"abc\"}"},"gas":"30000000000000","deposit":"1"}]}),
  None),
 ("07-plan-hash-send-unicode-note","planHash input for a send plan with a unicode note",
  json.dumps({"plan":{"kind":"send","asset":"USDC","amount":"12.5","to":"ada.penny.near","note":"jollof money 🍛 – thanks"},"actions":[{"type":"FunctionCall","methodName":"ft_transfer","args":{"receiver_id":"ada.penny.near","amount":"12500000"},"gas":"15000000000000","deposit":"1"}]}, ensure_ascii=False),
  None),
 ("08-lone-surrogate-rejected","Lone surrogate is not I-JSON and must be rejected", r'{"bad":"\ud800"}', "ERROR"),
]
for name,desc,inp,canon in V:
  d={"description":desc,"input":inp}
  if canon=="ERROR":
    d["expectError"]=True
  else:
    if canon is None:
      # computed: sorted keys, compact, no ascii escaping. Safe here (no numbers needing ES formatting, no control chars).
      canon=json.dumps(json.loads(inp),sort_keys=True,separators=(',',':'),ensure_ascii=False)
    d["canonical"]=canon; d["sha256Base64Url"]=h(canon)
  open(f"{out}/{name}.json","w",encoding="utf-8").write(json.dumps(d,ensure_ascii=False,indent=2)+"\n")
print(os.listdir(out))
