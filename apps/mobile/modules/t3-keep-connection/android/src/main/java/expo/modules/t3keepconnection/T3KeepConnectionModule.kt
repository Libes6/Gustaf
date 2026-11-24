package expo.modules.t3keepconnection

import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3KeepConnectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3KeepConnection")
    Events("onTurnedOff")

    OnCreate {
      KeepConnection.onTurnedOff = { sendEvent("onTurnedOff", Bundle.EMPTY) }
    }

    OnDestroy {
      KeepConnection.onTurnedOff = null
    }

    Function("start") { title: String, text: String, stopLabel: String, channelName: String ->
      val context = appContext.reactContext ?: return@Function false
      KeepConnection.start(context, KeepConnectionContent(title, text, stopLabel, channelName))
    }

    Function("stop") {
      appContext.reactContext?.let(KeepConnection::stop)
    }

    // Wall-clock start of the running service, or null; lets JS tell a kept-alive pause apart.
    Function("runningSince") {
      KeepConnection.runningSinceMs.takeIf { it > 0L }?.toDouble()
    }

    Function("takeTurnedOff") {
      appContext.reactContext?.let(KeepConnection::takeTurnedOff) ?: false
    }
  }
}
