import $elf from 'peersky://static/elves/elf.js'

const $ = $elf('hello-world')

$.draw((_target) => `Hello World`)

$elf($)
