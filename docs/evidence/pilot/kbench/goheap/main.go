package main

import "syscall/js"

type entry struct{ key uint64; pid int32 }
var h []entry

func push(pid int32, prio, seq uint32) {
	k := uint64(prio)<<32 | uint64(seq)
	h = append(h, entry{k, pid})
	i := len(h) - 1
	for i > 0 {
		p := (i - 1) / 2
		if h[i].key >= h[p].key { break }
		h[i], h[p] = h[p], h[i]
		i = p
	}
}
func pop() int32 {
	if len(h) == 0 { return -1 }
	top := h[0].pid
	n := len(h) - 1
	h[0] = h[n]; h = h[:n]
	i := 0
	for {
		l := 2*i + 1
		if l >= n { break }
		c := l
		if r := l + 1; r < n && h[r].key < h[l].key { c = r }
		if h[c].key >= h[i].key { break }
		h[i], h[c] = h[c], h[i]
		i = c
	}
	return top
}
func main() {
	js.Global().Set("goPush", js.FuncOf(func(this js.Value, a []js.Value) any { push(int32(a[0].Int()), uint32(a[1].Int()), uint32(a[2].Int())); return nil }))
	js.Global().Set("goPop", js.FuncOf(func(this js.Value, a []js.Value) any { return pop() }))
	js.Global().Set("goNoop", js.FuncOf(func(this js.Value, a []js.Value) any { return a[0] }))
	js.Global().Set("goClear", js.FuncOf(func(this js.Value, a []js.Value) any { h = h[:0]; return nil }))
	select {}
}
