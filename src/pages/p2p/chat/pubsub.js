class PubSub {
    constructor(channelName){
        this.channelName = channelName
        this.onopen = this.onopen.bind(this)
        this.onmessage = this.onmessage.bind(this)
        this.onerror = this.onerror.bind(this)
    }

    async listenForMsg() {
        let es = new EventSource(`pubsub://${this.channelName}/?format=json`)
        es.onmessage = this.onmessage
        es.onopen = this.onopen
        es.onerror = this.onerror
    }

    onopen(e) {
        console.log('onOpen', e)
        this.myRand = Math.random()
        let message = {msg: "hello", rnd: this.myRand}
        fetch(`pubsub://${this.channelName}/`, {
            method: 'POST',
            body: JSON.stringify(message),
        }).catch(console.error)

        document.getElementById('setup').classList.add('hidden')
        document.getElementById('chat').classList.remove('hidden')
        document.getElementById('roomName').innerHTML = this.channelName

        document.querySelector('#chatForm').addEventListener('submit', e => {
            e.preventDefault()
            let textInput = document.querySelector('#chat input')
            fetch(`pubsub://${this.channelName}/`, {
                method: 'POST',
                body: JSON.stringify({message: textInput.value}),
            }).catch(console.error)
            textInput.value = ''
        })
    }

    onmessage(e) {
        console.log('onmessage', e)
        try {
            let msg = JSON.parse(e.data)
            if (!this.whoami && msg.data.rnd && msg.data.rnd == this.myRand){
                console.log('Hello from myself. Yay!')
                this.whoami = msg.from
            } else if (msg.data.rnd && msg.data.rnd != this.myRand ){
                console.log('Hello from a friend!')
            } else {
                let textarea = document.querySelector('#chat textarea')
                textarea.value = textarea.value + `\n> ${msg.from}: ${msg.data.message}`
            }
        } catch (error) {
            console.log(error)
        }
    }


    onerror(e) {
        console.log('onmessage', e)
    }


}

window.addEventListener('load', (event) => {
    const form = document.getElementById('roomNameForm')
    form.addEventListener('submit', event => {
        event.preventDefault()
        const channelName = document.getElementById('channelNameInput').value
        console.log('start pubsub', channelName)
        window.pubsub = new PubSub(channelName)
        window.pubsub.listenForMsg().catch(console.error)
    })  
})

