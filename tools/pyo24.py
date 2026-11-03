"""Read Python 2.4 .pyo files from the Tabula Rasa client without Python 2.4.

The client's generated data modules (generated/client/*.pyo) are mostly
module-level assignments of literal tables. This module:
  * parses the Python 2.4 marshal format into Code objects,
  * disassembles code for inspection, and
  * symbolically evaluates module-level code to recover the literal values
    (unknown names/calls become Ref/Call placeholders instead of failing).

Usage:
  python -I tools/pyo24.py dis  <file.pyo>        # disassemble (recursive)
  python -I tools/pyo24.py dump <file.pyo>        # evaluated module namespace as JSON
"""
import json
import struct
import sys

MAGIC_24 = b'\x6d\xf2\x0d\x0a'


class Code:
    __slots__ = ('argcount', 'nlocals', 'stacksize', 'flags', 'code', 'consts', 'names',
                 'varnames', 'freevars', 'cellvars', 'filename', 'name', 'firstlineno', 'lnotab')

    def __repr__(self):
        return f'<code {self.name}>'


class Reader:
    def __init__(self, data):
        self.d = data
        self.i = 0
        self.interned = []

    def byte(self):
        b = self.d[self.i]
        self.i += 1
        return b

    def i32(self):
        v = struct.unpack_from('<i', self.d, self.i)[0]
        self.i += 4
        return v

    def raw(self, n):
        v = self.d[self.i:self.i + n]
        self.i += n
        return v

    def obj(self):
        t = chr(self.byte())
        if t == '0':
            return None
        if t == 'N':
            return None
        if t == 'F':
            return False
        if t == 'T':
            return True
        if t == 'S':
            return StopIteration
        if t == '.':
            return Ellipsis
        if t == 'i':
            return self.i32()
        if t == 'I':
            v = struct.unpack_from('<q', self.d, self.i)[0]
            self.i += 8
            return v
        if t == 'f':
            n = self.byte()
            return float(self.raw(n).decode('ascii'))
        if t == 'g':
            v = struct.unpack_from('<d', self.d, self.i)[0]
            self.i += 8
            return v
        if t == 'x':
            n = self.byte()
            re_ = float(self.raw(n).decode('ascii'))
            n = self.byte()
            im = float(self.raw(n).decode('ascii'))
            return complex(re_, im)
        if t == 'l':
            n = self.i32()
            size = abs(n)
            v = 0
            for k in range(size):
                digit = struct.unpack_from('<H', self.d, self.i)[0]
                self.i += 2
                v |= digit << (15 * k)
            return -v if n < 0 else v
        if t in 's':
            return self.str_(self.raw(self.i32()))
        if t == 't':
            s = self.str_(self.raw(self.i32()))
            self.interned.append(s)
            return s
        if t == 'R':
            return self.interned[self.i32()]
        if t == 'u':
            return self.raw(self.i32()).decode('utf-8')
        if t == '(':
            return tuple(self.obj() for _ in range(self.i32()))
        if t == '[':
            return [self.obj() for _ in range(self.i32())]
        if t == '{':
            d = {}
            while True:
                k = self.obj_or_null()
                if k is _NULL:
                    break
                d[k] = self.obj()
            return d
        if t == 'c':
            c = Code()
            c.argcount = self.i32()
            c.nlocals = self.i32()
            c.stacksize = self.i32()
            c.flags = self.i32()
            c.code = self.obj()
            c.consts = self.obj()
            c.names = self.obj()
            c.varnames = self.obj()
            c.freevars = self.obj()
            c.cellvars = self.obj()
            c.filename = self.obj()
            c.name = self.obj()
            c.firstlineno = self.i32()
            c.lnotab = self.obj()
            return c
        raise ValueError(f'unknown marshal type {t!r} at {self.i - 1}')

    def obj_or_null(self):
        if chr(self.d[self.i]) == '0':
            self.i += 1
            return _NULL
        return self.obj()

    @staticmethod
    def str_(b):
        # Byte strings in 2.4 are usually ASCII/latin-1; bytecode must stay bytes.
        try:
            return b.decode('ascii')
        except UnicodeDecodeError:
            return Bytes(b)


class Bytes(bytes):
    """Non-ASCII byte string (bytecode, or latin-1 text)."""


_NULL = object()


def load(path):
    return loads(open(path, 'rb').read(), path)


def loads(data, label='<bytes>'):
    if data[:4] != MAGIC_24:
        raise ValueError(f'{label}: not a Python 2.4 file (magic {data[:4].hex()})')
    return Reader(data[8:]).obj()


def code_bytes(c):
    b = c.code
    return b if isinstance(b, bytes) else b.encode('latin-1')


# Python 2.4 opcode table (only names; HAVE_ARGUMENT = 90).
OPNAMES = {
    1: 'POP_TOP', 2: 'ROT_TWO', 3: 'ROT_THREE', 4: 'DUP_TOP', 5: 'ROT_FOUR', 9: 'NOP',
    10: 'UNARY_POSITIVE', 11: 'UNARY_NEGATIVE', 12: 'UNARY_NOT', 13: 'UNARY_CONVERT', 15: 'UNARY_INVERT',
    18: 'LIST_APPEND', 19: 'BINARY_POWER', 20: 'BINARY_MULTIPLY', 21: 'BINARY_DIVIDE', 22: 'BINARY_MODULO',
    23: 'BINARY_ADD', 24: 'BINARY_SUBTRACT', 25: 'BINARY_SUBSCR', 26: 'BINARY_FLOOR_DIVIDE',
    27: 'BINARY_TRUE_DIVIDE', 28: 'INPLACE_FLOOR_DIVIDE', 29: 'INPLACE_TRUE_DIVIDE',
    30: 'SLICE+0', 31: 'SLICE+1', 32: 'SLICE+2', 33: 'SLICE+3',
    55: 'INPLACE_ADD', 56: 'INPLACE_SUBTRACT', 57: 'INPLACE_MULTIPLY', 58: 'INPLACE_DIVIDE',
    59: 'INPLACE_MODULO', 60: 'STORE_SUBSCR', 61: 'DELETE_SUBSCR', 62: 'BINARY_LSHIFT', 63: 'BINARY_RSHIFT',
    64: 'BINARY_AND', 65: 'BINARY_XOR', 66: 'BINARY_OR', 67: 'INPLACE_POWER', 68: 'GET_ITER',
    70: 'PRINT_EXPR', 71: 'PRINT_ITEM', 72: 'PRINT_NEWLINE', 75: 'INPLACE_LSHIFT', 76: 'INPLACE_RSHIFT',
    77: 'INPLACE_AND', 78: 'INPLACE_XOR', 79: 'INPLACE_OR', 80: 'BREAK_LOOP', 82: 'LOAD_LOCALS',
    83: 'RETURN_VALUE', 84: 'IMPORT_STAR', 85: 'EXEC_STMT', 86: 'YIELD_VALUE', 87: 'POP_BLOCK',
    88: 'END_FINALLY', 89: 'BUILD_CLASS',
    90: 'STORE_NAME', 91: 'DELETE_NAME', 92: 'UNPACK_SEQUENCE', 93: 'FOR_ITER', 95: 'STORE_ATTR',
    96: 'DELETE_ATTR', 97: 'STORE_GLOBAL', 98: 'DELETE_GLOBAL', 99: 'DUP_TOPX', 100: 'LOAD_CONST',
    101: 'LOAD_NAME', 102: 'BUILD_TUPLE', 103: 'BUILD_LIST', 104: 'BUILD_MAP', 105: 'LOAD_ATTR',
    106: 'COMPARE_OP', 107: 'IMPORT_NAME', 108: 'IMPORT_FROM', 110: 'JUMP_FORWARD',
    111: 'JUMP_IF_FALSE', 112: 'JUMP_IF_TRUE', 113: 'JUMP_ABSOLUTE', 116: 'LOAD_GLOBAL',
    119: 'CONTINUE_LOOP', 120: 'SETUP_LOOP', 121: 'SETUP_EXCEPT', 122: 'SETUP_FINALLY',
    124: 'LOAD_FAST', 125: 'STORE_FAST', 126: 'DELETE_FAST', 130: 'RAISE_VARARGS',
    131: 'CALL_FUNCTION', 132: 'MAKE_FUNCTION', 133: 'BUILD_SLICE', 134: 'MAKE_CLOSURE',
    135: 'LOAD_CLOSURE', 136: 'LOAD_DEREF', 137: 'STORE_DEREF', 140: 'CALL_FUNCTION_VAR',
    141: 'CALL_FUNCTION_KW', 142: 'CALL_FUNCTION_VAR_KW', 143: 'EXTENDED_ARG',
}
CMP = ('<', '<=', '==', '!=', '>', '>=', 'in', 'not in', 'is', 'is not', 'exception match', 'BAD')


def instructions(c):
    b = code_bytes(c)
    i, ext = 0, 0
    while i < len(b):
        op = b[i]
        start = i
        i += 1
        arg = None
        if op >= 90:
            arg = b[i] | (b[i + 1] << 8) | ext
            i += 2
            ext = 0
            if op == 143:
                ext = arg << 16
                continue
        yield start, op, OPNAMES.get(op, f'OP{op}'), arg, i


def describe(c, op, arg):
    if arg is None:
        return ''
    name = OPNAMES.get(op, '')
    if name == 'LOAD_CONST':
        v = c.consts[arg]
        return repr(v) if not isinstance(v, Code) else repr(v)
    if name in ('STORE_NAME', 'LOAD_NAME', 'LOAD_ATTR', 'STORE_ATTR', 'IMPORT_NAME', 'IMPORT_FROM',
                'LOAD_GLOBAL', 'STORE_GLOBAL', 'DELETE_NAME'):
        return c.names[arg]
    if name in ('LOAD_FAST', 'STORE_FAST'):
        return c.varnames[arg]
    if name == 'COMPARE_OP':
        return CMP[arg]
    return str(arg)


def disassemble(c, indent=0, out=sys.stdout):
    pad = '  ' * indent
    out.write(f'{pad}== {c.name} (args={c.argcount}, vars={c.varnames})\n')
    for off, op, name, arg, _ in instructions(c):
        out.write(f'{pad}{off:6d} {name:20s} {describe(c, op, arg)}\n')
    for k in c.consts:
        if isinstance(k, Code):
            disassemble(k, indent + 1, out)


class Ref:
    def __init__(self, path):
        self.path = path

    def __repr__(self):
        return self.path


class Call:
    def __init__(self, fn, args, kwargs):
        self.fn, self.args, self.kwargs = fn, args, kwargs

    def __repr__(self):
        return f'{self.fn!r}(...)'


class Func:
    def __init__(self, code, defaults):
        self.code, self.defaults = code, defaults

    def __repr__(self):
        return f'<def {self.code.name}>'


class ClassDef:
    def __init__(self, name, bases, ns):
        self.name, self.bases, self.ns = name, bases, ns

    def __repr__(self):
        return f'<class {self.name}>'


def evaluate(c, ns=None):
    """Symbolically run straight-line module/class code; returns the namespace dict.

    Branches and loops are not followed (generated data modules are linear)."""
    ns = {} if ns is None else ns
    st = []
    for off, op, name, arg, nxt in instructions(c):
        try:
            if name == 'LOAD_CONST':
                st.append(c.consts[arg])
            elif name in ('LOAD_NAME', 'LOAD_GLOBAL'):
                n = c.names[arg]
                st.append(ns.get(n, Ref(n)))
            elif name in ('STORE_NAME', 'STORE_GLOBAL'):
                ns[c.names[arg]] = st.pop()
            elif name == 'LOAD_ATTR':
                o = st.pop()
                n = c.names[arg]
                if isinstance(o, ClassDef) and n in o.ns:
                    st.append(o.ns[n])
                else:
                    st.append(Ref(f'{o!r}.{n}'))
            elif name == 'STORE_ATTR':
                o = st.pop()
                v = st.pop()
                if isinstance(o, ClassDef):
                    o.ns[c.names[arg]] = v
            elif name == 'BUILD_TUPLE':
                items = st[len(st) - arg:] if arg else []
                del st[len(st) - arg:]
                st.append(tuple(items))
            elif name == 'BUILD_LIST':
                items = st[len(st) - arg:] if arg else []
                del st[len(st) - arg:]
                st.append(list(items))
            elif name == 'BUILD_MAP':
                st.append({})
            elif name == 'STORE_SUBSCR':
                key = st.pop()
                obj = st.pop()
                val = st.pop()
                try:
                    obj[_hashable(key)] = val
                except TypeError:
                    pass
            elif name == 'BINARY_SUBSCR':
                key = st.pop()
                obj = st.pop()
                try:
                    st.append(obj[_hashable(key)])
                except Exception:
                    st.append(Ref(f'{obj!r}[{key!r}]'))
            elif name == 'DUP_TOP':
                st.append(st[-1])
            elif name == 'ROT_TWO':
                st[-1], st[-2] = st[-2], st[-1]
            elif name == 'ROT_THREE':
                st[-1], st[-2], st[-3] = st[-2], st[-3], st[-1]
            elif name == 'POP_TOP':
                st.pop()
            elif name == 'UNARY_NEGATIVE':
                v = st.pop()
                st.append(-v if isinstance(v, (int, float)) else Ref(f'-{v!r}'))
            elif name in ('BINARY_ADD', 'BINARY_SUBTRACT', 'BINARY_MULTIPLY', 'BINARY_DIVIDE',
                          'BINARY_OR', 'BINARY_AND', 'BINARY_LSHIFT', 'BINARY_TRUE_DIVIDE', 'BINARY_FLOOR_DIVIDE'):
                b = st.pop()
                a = st.pop()
                st.append(_binop(name, a, b))
            elif name == 'IMPORT_NAME':
                st.pop()  # fromlist
                st.append(Ref(c.names[arg]))
            elif name == 'IMPORT_FROM':
                st.append(Ref(f'{st[-1]!r}.{c.names[arg]}'))
            elif name == 'IMPORT_STAR':
                st.pop()
            elif name == 'MAKE_FUNCTION':
                code = st.pop()
                defaults = st[len(st) - arg:] if arg else []
                del st[len(st) - arg:]
                st.append(Func(code, defaults))
            elif name in ('CALL_FUNCTION', 'CALL_FUNCTION_VAR', 'CALL_FUNCTION_KW', 'CALL_FUNCTION_VAR_KW'):
                extra = {'CALL_FUNCTION': 0, 'CALL_FUNCTION_VAR': 1, 'CALL_FUNCTION_KW': 1, 'CALL_FUNCTION_VAR_KW': 2}[name]
                for _ in range(extra):
                    st.pop()
                nkw, npos = arg >> 8, arg & 0xff
                kwargs = {}
                for _ in range(nkw):
                    v = st.pop()
                    k = st.pop()
                    kwargs[k] = v
                args = st[len(st) - npos:] if npos else []
                del st[len(st) - npos:]
                fn = st.pop()
                if isinstance(fn, Func) and not args and not kwargs and fn.code.argcount == 0:
                    # class body
                    st.append(evaluate(fn.code, {}))
                else:
                    st.append(Call(fn, list(args), kwargs))
            elif name == 'LOAD_LOCALS':
                st.append(ns)
            elif name == 'BUILD_CLASS':
                body = st.pop()
                bases = st.pop()
                cname = st.pop()
                st.append(ClassDef(cname, bases, body if isinstance(body, dict) else {}))
            elif name == 'RETURN_VALUE':
                return ns  # module code returns None; class bodies return their locals (== ns)
            elif name in ('NOP', 'POP_BLOCK', 'SETUP_LOOP', 'SETUP_EXCEPT', 'SETUP_FINALLY'):
                pass
            else:
                # Unsupported control flow: stop here, keep what we have.
                ns.setdefault('__unsupported__', []).append(f'{name} at {off}')
                return ns
        except IndexError:
            ns.setdefault('__unsupported__', []).append(f'stack underflow at {off} {name}')
            return ns
    return ns


def _hashable(k):
    if isinstance(k, list):
        return tuple(k)
    if isinstance(k, (Ref, Call, Func, ClassDef)):
        return repr(k)
    return k


def _binop(name, a, b):
    try:
        if name == 'BINARY_ADD':
            return a + b
        if name == 'BINARY_SUBTRACT':
            return a - b
        if name == 'BINARY_MULTIPLY':
            return a * b
        if name in ('BINARY_DIVIDE', 'BINARY_TRUE_DIVIDE'):
            return a / b
        if name == 'BINARY_FLOOR_DIVIDE':
            return a // b
        if name == 'BINARY_OR':
            return a | b
        if name == 'BINARY_AND':
            return a & b
        if name == 'BINARY_LSHIFT':
            return a << b
    except Exception:
        pass
    return Ref(f'({a!r} {name} {b!r})')


def to_jsonable(v):
    if isinstance(v, dict):
        return {str(k) if not isinstance(k, (str, int, float, bool)) or isinstance(k, tuple) else k: to_jsonable(x)
                for k, x in v.items() if not (isinstance(k, str) and k.startswith('__') and k != '__unsupported__')}
    if isinstance(v, (list, tuple)):
        return [to_jsonable(x) for x in v]
    if isinstance(v, ClassDef):
        return {'__class__': v.name, **to_jsonable(v.ns)}
    if isinstance(v, Call):
        return {'__call__': repr(v.fn), 'args': to_jsonable(v.args), 'kwargs': to_jsonable(v.kwargs)}
    if isinstance(v, (Ref, Func, Code)):
        return repr(v)
    if isinstance(v, Bytes):
        return v.decode('latin-1')
    if isinstance(v, float) and v != v:
        return None
    return v


if __name__ == '__main__':
    cmd, path = sys.argv[1], sys.argv[2]
    sys.stdout.reconfigure(encoding='utf-8')
    code = load(path)
    if cmd == 'dis':
        disassemble(code)
    elif cmd == 'dump':
        print(json.dumps(to_jsonable(evaluate(code)), indent=1, ensure_ascii=False, default=repr))
    else:
        sys.exit(__doc__)
