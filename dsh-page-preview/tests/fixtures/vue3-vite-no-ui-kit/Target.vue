<script>
import { ref, inject } from 'vue'
export default {
  props: ['label'],
  setup: function () {
    if (window.fixtureRole !== 'reader') throw new Error('Scenario was not applied before target')
    return { count: ref(0), installed: inject('installed'), rootValue: inject('rootValue') }
  },
}
</script>
<template>
  <article><h1>{{ label }}</h1><p>revision-1</p><fixture-label label="Registered component" />
    <p>{{ installed }} / {{ rootValue }} / {{ $fixture }}</p>
    <button @click="count++">Increment counter: {{ count }}</button>
  </article>
</template>
<style scoped>article { border-left: 3px solid #246; padding-left: 12px }</style>
