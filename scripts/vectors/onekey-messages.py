#!/usr/bin/env python3
"""Independent encoder oracle for the OneKey protocol client (vectors/onekey/messages.json).

The TypeScript client carries its own minimal protobuf codec and hand-written message
descriptors. This script encodes the same messages with Google's reference protobuf runtime
from OneKey's published .proto schemas, compiled at generation time by grpcio-tools' protoc from
a firmware checkout at the pinned commit — nothing of the LGPL-3.0 schema is committed, only the
resulting bytes. Every message that exists in both the Pro and the Classic 1S schema is encoded
with both and must produce identical bytes, which proves one descriptor serves both firmwares.

It also frames payloads with an independent implementation of protocol V1
(firmware common/protob/protocol.md: 64-byte reports) and of the BLE device-to-host stream
(bluetooth-firmware-pro app/data_transmission.c: `?##` header, contiguous payload, MTU split).

JSON value convention: uint32/enum → number, uint64 → decimal string, bytes → lowercase hex,
nested message → object, repeated → array; keys are the proto field names in lowerCamelCase.

Requirements (recorded in the output):
  python3 -m venv venv && venv/bin/pip install protobuf==6.33.6 grpcio-tools==1.80.1
Usage:
  git clone https://github.com/OneKeyHQ/firmware-pro && git -C firmware-pro checkout 251a1b76…
  git clone https://github.com/OneKeyHQ/firmware-classic1s && git -C firmware-classic1s checkout be08c78d…
  venv/bin/python scripts/vectors/onekey-messages.py firmware-pro firmware-classic1s \
      > vectors/onekey/messages.json
"""
import glob
import importlib
import json
import os
import subprocess
import sys
import tempfile
from importlib.metadata import version

PRO_COMMIT = "251a1b762065357059f80f32b28cb502609510d3"  # firmware-pro tag v4.21.0
CLASSIC1S_COMMIT = "be08c78d2230f11028bca55ae65469e64ad45e4a"  # firmware-classic1s tag v3.21.0


def compile_schema(checkout, commit, tag):
    head = subprocess.check_output(["git", "-C", checkout, "rev-parse", "HEAD"], text=True).strip()
    if head != commit:
        sys.exit(f"{checkout} is at {head}, expected {commit}")
    protob = os.path.join(checkout, "common", "protob")
    out = tempfile.mkdtemp(prefix=f"onekey-{tag}-")
    import grpc_tools
    from grpc_tools import protoc

    well_known = os.path.join(os.path.dirname(grpc_tools.__file__), "_proto")
    files = sorted(os.path.basename(p) for p in glob.glob(os.path.join(protob, "*.proto")))
    if protoc.main(["protoc", f"-I{protob}", f"-I{well_known}", f"--python_out={out}", *files]) != 0:
        sys.exit(f"protoc failed for {checkout}")
    sys.path.insert(0, out)
    modules = {}
    for name in files:
        module = name[: -len(".proto")].replace("-", "_") + "_pb2"
        modules[module] = importlib.import_module(module)
    by_name = {}
    for module in modules.values():
        for descriptor in module.DESCRIPTOR.message_types_by_name.values():
            by_name[descriptor.name] = getattr(module, descriptor.name)
    message_type = modules["messages_pb2"].MessageType
    return by_name, message_type


def camel(name):
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def fill(message, fields):
    for key, value in fields.items():
        field = message.DESCRIPTOR.fields_by_name[key]
        repeated = field.is_repeated
        values = value if repeated else [value]
        for item in values:
            if field.type == field.TYPE_MESSAGE:
                target = getattr(message, key).add() if repeated else getattr(message, key)
                fill(target, item)
                continue
            converted = bytes.fromhex(item) if field.type == field.TYPE_BYTES else item
            if field.type in (field.TYPE_UINT64, field.TYPE_INT64):
                converted = int(item)
            if repeated:
                getattr(message, key).append(converted)
            else:
                setattr(message, key, converted)


def to_json(message):
    out = {}
    for field, value in message.ListFields():
        repeated = field.is_repeated
        items = list(value) if repeated else [value]
        rendered = []
        for item in items:
            if field.type == field.TYPE_MESSAGE:
                rendered.append(to_json(item))
            elif field.type == field.TYPE_BYTES:
                rendered.append(item.hex())
            elif field.type in (field.TYPE_UINT64, field.TYPE_INT64):
                rendered.append(str(item))
            else:
                rendered.append(item)
        out[camel(field.name)] = rendered if repeated else rendered[0]
    return out


H32 = "11" * 32
H32B = "22" * 32
XPUB = "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V"

# (message name, fields with proto names) — one entry per shape the client encodes or decodes.
CASES = [
    ("Initialize", {}),
    ("Initialize", {"session_id": H32}),
    ("GetFeatures", {}),
    ("Cancel", {}),
    ("ButtonAck", {}),
    ("BixinPinInputOnDevice", {}),
    ("PassphraseAck", {"on_device": True}),
    ("Success", {"message": "ok"}),
    ("Failure", {"code": 4, "message": "Action cancelled by user"}),
    ("Failure", {"code": 99}),
    ("ButtonRequest", {"code": 8}),
    ("ButtonRequest", {"code": 8000, "pages": 3}),
    ("PinMatrixRequest", {"type": 1}),
    ("PassphraseRequest", {}),
    ("PassphraseRequest", {"exists_attach_pin_user": True}),
    (
        "Features",
        {
            "vendor": "onekey.so",
            "major_version": 2,
            "minor_version": 99,
            "patch_version": 99,
            "bootloader_mode": False,
            "device_id": "F1E2D3C4B5A69788",
            "pin_protection": True,
            "passphrase_protection": False,
            "label": "OneKey Pro",
            "initialized": True,
            "revision": "0123456789abcdef",
            "unlocked": True,
            "model": "T",
            "capabilities": [1, 2, 3, 5, 7, 8, 14],
            "session_id": H32,
            "onekey_device_type": 5,
            "onekey_firmware_version": "4.21.0",
            "onekey_serial_no": "PRA00000000000",
            "onekey_ble_name": "Pro ABCD",
        },
    ),
    ("Features", {"major_version": 3, "minor_version": 21, "patch_version": 0, "onekey_device_type": 1}),
    ("GetPublicKey", {"address_n": [0x80000056, 0x80000000, 0x80000000], "coin_name": "Bitcoin", "script_type": 4}),
    ("GetPublicKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000], "show_display": False}),
    (
        "PublicKey",
        {
            "node": {
                "depth": 3,
                "fingerprint": 0x7ABC1234,
                "child_num": 0x80000000,
                "chain_code": H32,
                "public_key": "02" + H32B,
            },
            "xpub": XPUB,
            "root_fingerprint": 0x73C5DA0A,
        },
    ),
    ("GetAddress", {"address_n": [0x80000054, 0x80000000, 0x80000000, 0, 0], "coin_name": "Bitcoin", "show_display": True, "script_type": 3}),
    ("Address", {"address": "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"}),
    ("SignMessage", {"address_n": [0x80000054, 0x80000000, 0x80000000, 0, 0], "message": "68656c6c6f", "coin_name": "Bitcoin", "script_type": 3}),
    ("SignMessage", {"address_n": [0x80000056, 0x80000000, 0x80000000, 0, 0], "message": "68656c6c6f", "script_type": 4, "is_bip322_simple": True}),
    ("SignMessage", {"address_n": [0x8000002C, 0x80000000, 0x80000000, 0, 0], "message": "", "no_script_type": True}),
    ("MessageSignature", {"address": "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", "signature": "1f" + H32 + H32B}),
    ("SignPsbt", {"psbt": "70736274ff0100", "coin_name": "Bitcoin"}),
    ("SignedPsbt", {"psbt": "70736274ff01"}),
    ("EthereumGetPublicKeyOneKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000], "chain_id": 1}),
    ("EthereumPublicKeyOneKey", {"node": {"depth": 3, "fingerprint": 1, "child_num": 0x80000000, "chain_code": H32, "public_key": "03" + H32B}, "xpub": XPUB}),
    ("EthereumGetAddressOneKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0], "show_display": True, "chain_id": 1}),
    ("EthereumAddressOneKey", {"address": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"}),
    (
        "EthereumSignTxOneKey",
        {
            "address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
            "nonce": "",
            "gas_price": "04a817c800",
            "gas_limit": "5208",
            "to": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "value": "0de0b6b3a7640000",
            "chain_id": 1,
        },
    ),
    (
        "EthereumSignTxOneKey",
        {
            "address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
            "nonce": "07",
            "gas_price": "01",
            "gas_limit": "0186a0",
            "value": "",
            "data_initial_chunk": "a9059cbb" + "00" * 60,
            "data_length": 2048,
            "chain_id": 18446744073709551615,
            "tx_type": 0,
        },
    ),
    (
        "EthereumSignTxEIP1559OneKey",
        {
            "address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
            "nonce": "01",
            "max_gas_fee": "3b9aca00",
            "max_priority_fee": "3b9aca00",
            "gas_limit": "5208",
            "to": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "value": "01",
            "data_length": 0,
            "chain_id": 8453,
            "access_list": [{"address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "storage_keys": [H32, H32B]}],
        },
    ),
    (
        "EthereumSignTxEIP7702OneKey",
        {
            "address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
            "nonce": "05",
            "max_gas_fee": "3b9aca00",
            "max_priority_fee": "01",
            "gas_limit": "0186a0",
            "to": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "value": "",
            "data_length": 0,
            "chain_id": 1,
            "authorization_list": [
                {
                    "address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
                    "chain_id": 1,
                    "address": "0x0000000000000000000000000000000000000000",
                    "nonce": "06",
                }
            ],
        },
    ),
    ("EthereumTxRequestOneKey", {"data_length": 1024}),
    ("EthereumTxRequestOneKey", {"signature_v": 1, "signature_r": H32, "signature_s": H32B}),
    (
        "EthereumTxRequestOneKey",
        {
            "signature_v": 0,
            "signature_r": H32,
            "signature_s": H32B,
            "authorization_signatures": [{"y_parity": 1, "r": H32B, "s": H32}],
        },
    ),
    ("EthereumTxAckOneKey", {"data_chunk": "ab" * 1024}),
    ("EthereumSignMessageOneKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0], "message": "68656c6c6f", "chain_id": 1}),
    ("EthereumMessageSignatureOneKey", {"signature": H32 + H32B + "1b", "address": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"}),
    ("EthereumSignTypedDataOneKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0], "primary_type": "Mail", "metamask_v4_compat": True, "chain_id": 1}),
    ("EthereumTypedDataStructRequestOneKey", {"name": "Person"}),
    (
        "EthereumTypedDataStructAckOneKey",
        {
            "members": [
                {"type": {"data_type": 5}, "name": "name"},
                {"type": {"data_type": 3}, "name": "wallet"},
                {"type": {"data_type": 7, "size": 2, "entry_type": {"data_type": 8, "struct_name": "Person"}}, "name": "to"},
                {"type": {"data_type": 1, "size": 32}, "name": "amount"},
            ]
        },
    ),
    ("EthereumTypedDataValueRequestOneKey", {"member_path": [0, 1, 2]}),
    ("EthereumTypedDataValueAckOneKey", {"value": "0000000000000000000000000000000000000001"}),
    ("EthereumTypedDataSignatureOneKey", {"signature": H32 + H32B + "1c", "address": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"}),
    ("EthereumSignTypedHashOneKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0], "domain_separator_hash": H32, "message_hash": H32B, "chain_id": 1}),
    ("EthereumSignTypedHashOneKey", {"address_n": [0x8000002C, 0x8000003C, 0x80000000, 0, 0], "domain_separator_hash": H32}),
    ("SolanaGetAddress", {"address_n": [0x8000002C, 0x800001F5, 0x80000000, 0x80000000], "show_display": True}),
    ("SolanaAddress", {"address": "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"}),
    ("SolanaSignTx", {"address_n": [0x8000002C, 0x800001F5, 0x80000000, 0x80000000], "raw_tx": "01000103" + "00" * 100}),
    ("SolanaSignedTx", {"signature": H32 + H32B}),
    ("SolanaSignUnsafeMessage", {"address_n": [0x8000002C, 0x800001F5, 0x80000000, 0x80000000], "message": "deadbeef"}),
    ("SolanaMessageSignature", {"signature": H32 + H32B, "public_key": H32}),
    ("TronGetAddress", {"address_n": [0x8000002C, 0x800000C3, 0x80000000, 0, 0], "show_display": False}),
    ("TronAddress", {"address": "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH"}),
    (
        "TronSignTx",
        {
            "address_n": [0x8000002C, 0x800000C3, 0x80000000, 0, 0],
            "ref_block_bytes": "1a2b",
            "ref_block_hash": "0102030405060708",
            "expiration": 1700000060000,
            "contract": {"transfer_contract": {"to_address": "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH", "amount": 1000000}},
            "timestamp": 1700000000000,
        },
    ),
    (
        "TronSignTx",
        {
            "address_n": [0x8000002C, 0x800000C3, 0x80000000, 0, 0],
            "ref_block_bytes": "1a2b",
            "ref_block_hash": "0102030405060708",
            "expiration": 1700000060000,
            "data": "6d656d6f",
            "contract": {
                "trigger_smart_contract": {
                    "contract_address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
                    "call_value": 0,
                    "data": "a9059cbb" + "00" * 64,
                },
                "permission_id": 2,
            },
            "timestamp": 1700000000000,
            "fee_limit": 30000000,
        },
    ),
    ("TronSignedTx", {"signature": H32 + H32B + "00", "serialized_tx": "0a021a2b"}),
    ("TronSignMessage", {"address_n": [0x8000002C, 0x800000C3, 0x80000000, 0, 0], "message": "68656c6c6f", "message_type": 2}),
    ("TronMessageSignature", {"address": b"TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH".hex(), "signature": H32 + H32B + "1b"}),
]


def frames(message_type, payload):
    """protocol.md V1: `?##` + BE u16 type + BE u32 length, 64-byte reports, zero padded."""
    stream = b"##" + message_type.to_bytes(2, "big") + len(payload).to_bytes(4, "big") + payload
    reports = []
    for offset in range(0, max(len(stream), 1), 63):
        chunk = stream[offset : offset + 63]
        reports.append((b"?" + chunk + b"\x00" * (63 - len(chunk))).hex())
    return reports


def ble_notifications(message_type, payload, mtu):
    """bluetooth-firmware-pro: `?##` header then the payload contiguous, cut at the MTU."""
    stream = b"?##" + message_type.to_bytes(2, "big") + len(payload).to_bytes(4, "big") + payload
    return [stream[i : i + mtu].hex() for i in range(0, len(stream), mtu)]


def encode_all(checkout, commit, tag):
    """One schema per process: protobuf's default descriptor pool rejects a second copy."""
    schema, enum = compile_schema(checkout, commit, tag)
    out = []
    for name, fields in CASES:
        if name not in schema:
            out.append(None)
            continue
        message = schema[name]()
        fill(message, fields)
        missing = message.FindInitializationErrors()
        if missing:
            sys.exit(f"{name}: missing required {missing}")
        out.append(
            {
                "type": enum.Value(f"MessageType_{name}"),
                "fields": to_json(message),
                "encoded": message.SerializeToString().hex(),
            }
        )
    return out


def encode_in_subprocess(checkout, commit, tag):
    result = subprocess.run(
        [sys.executable, __file__, "--schema", checkout, commit, tag],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def main():
    if len(sys.argv) == 5 and sys.argv[1] == "--schema":
        json.dump(encode_all(*sys.argv[2:5]), sys.stdout)
        return
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pro = encode_in_subprocess(sys.argv[1], PRO_COMMIT, "pro")
    classic = encode_in_subprocess(sys.argv[2], CLASSIC1S_COMMIT, "classic1s")
    messages = []
    for (name, _), in_pro, in_classic in zip(CASES, pro, classic):
        present = [(tag, item) for tag, item in (("pro", in_pro), ("classic1s", in_classic)) if item]
        if not present or len({json.dumps(item, sort_keys=True) for _, item in present}) != 1:
            sys.exit(f"{name}: schemas disagree or message missing")
        item = present[0][1]
        encoded = bytes.fromhex(item["encoded"])
        messages.append(
            {
                "name": name,
                "type": item["type"],
                "schemas": [tag for tag, _ in present],
                "fields": item["fields"],
                "encoded": item["encoded"],
                "reports": frames(item["type"], encoded),
                "ble": {str(mtu): ble_notifications(item["type"], encoded, mtu) for mtu in (20, 182)},
            }
        )
    json.dump(
        {
            "sources": {
                "firmware-pro": {"repository": "https://github.com/OneKeyHQ/firmware-pro", "commit": PRO_COMMIT, "tag": "v4.21.0"},
                "firmware-classic1s": {"repository": "https://github.com/OneKeyHQ/firmware-classic1s", "commit": CLASSIC1S_COMMIT, "tag": "v3.21.0"},
                "schema": "common/protob/*.proto (LGPL-3.0, compiled at generation time, not committed)",
            },
            "generator": {"protobuf": version("protobuf"), "grpcio-tools": version("grpcio-tools")},
            "messages": messages,
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
